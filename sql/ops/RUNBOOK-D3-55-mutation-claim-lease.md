# D3-55 후속 — 변형 lease(`mutation_claimed_at`) 배포 RUNBOOK

**PR #570 리뷰(이기성) MEDIUM "외부 API 출시 전 재발행 원자화 또는 진행중 플래그 필요" 대응.**

---

## ⛔ 배포 순서 (역전 시 전면 장애)

```
① migration/mutation-claim-lease.sql 적용   ← DB 먼저
② 코드 배포                                  ← 그 다음
```

**이 순서를 지키지 않으면 서비스가 뜨자마자 죽습니다.**

`OrderDeliveryEntity` 에 `mutationClaimedAt` 컬럼이 선언되어 있으므로, TypeORM 이 발행하는
**모든 `order_delivery` SELECT 가 `mutation_claimed_at` 을 조회**합니다.
컬럼 없이 코드가 먼저 뜨면 주문·발송·CS 조회가 전부 `Unknown column 'mutation_claimed_at'` 로
실패합니다 (부분 장애가 아니라 **전면 장애**).

### 롤백

코드만 이전 버전으로 되돌립니다. **컬럼은 남겨 두십시오** — 구버전 코드는 이 컬럼을 참조하지
않으므로 남아 있어도 무해하고, 재배포 시 다시 만들 필요가 없습니다.
컬럼을 지우면 롤백 도중 신버전 파드가 하나라도 살아 있을 때 위와 같은 전면 장애가 납니다.

---

## 1. 적용 전 확인 (DBA / 인프라)

| 항목 | 확인 방법 | 왜 |
|---|---|---|
| **MySQL 버전** | `SELECT VERSION();` | 8.0 이면 nullable 컬럼 추가가 `ALGORITHM=INSTANT` (무중단). **5.7 이면 테이블 재작성** — `order_delivery` 행수에 비례해 잠깁니다. |
| **`order_delivery` 행수** | `SELECT COUNT(*) FROM order_delivery;` | 5.7 인 경우 재작성 시간 산정용. |
| **컬럼 중복** | `SHOW COLUMNS FROM order_delivery LIKE 'mutation_claimed_at';` | 이미 있으면 ALTER 를 건너뜁니다(멱등 아님 — 재실행 시 에러). |

> ⚠️ 이 저장소는 스키마를 레포 밖 수기 SQL(`migration/`)로 관리합니다.
> 위 3개는 **실 DB 에서 직접 확인**해야 하며, 코드만 보고 단정할 수 없습니다.

---

## 2. 적용

```sql
-- migration/mutation-claim-lease.sql
ALTER TABLE `order_delivery` ADD COLUMN `mutation_claimed_at` DATETIME(6) NULL
  COMMENT '쿠폰상태 변형(폐기/취소/재발행) 진행중 lease. 발송배치용 claimed_at 과 별개' AFTER `claimed_at`;
```

- **인덱스 불필요.** 이 컬럼의 모든 접근은 `WHERE id = ?` 로 PK 를 먼저 좁힌 뒤의 추가 술어이거나,
  이미 `idx_order_delivery_claim` 이 커버하는 배치 claim 쿼리의 추가 술어입니다.
- **백필 불필요.** `NULL` = "아무도 점유하지 않음" 이 정상 초기값입니다.

### 적용 후 검증

```sql
SHOW COLUMNS FROM order_delivery LIKE 'mutation_claimed_at';
-- Type=datetime(6), Null=YES, Default=NULL 이어야 함

SELECT COUNT(*) FROM order_delivery WHERE mutation_claimed_at IS NOT NULL;
-- 코드 배포 전이므로 0 이어야 함
```

---

## 3. 배포 후 모니터링

### 정상 상태

```sql
-- 활성 lease 는 항상 소수(수 초짜리 작업)여야 한다
SELECT COUNT(*) FROM order_delivery
 WHERE mutation_claimed_at IS NOT NULL
   AND mutation_claimed_at > NOW(6) - INTERVAL 5 MINUTE;
```

### 이상 신호

| 증상 | 의미 | 조치 |
|---|---|---|
| 위 쿼리 결과가 지속적으로 큼 | lease 해제(`finally`)가 실패하고 있다 | `[변형lease] 해제 실패` 로그 확인. DB 장애 신호일 수 있음 |
| `stale`(5분 초과) 행이 쌓임 | 크래시로 해제를 못 탄 잔재 | CAS self-heal 이 다음 획득자에서 자동 회수하므로 방치해도 수렴. 지속되면 파드 OOM/재시작 확인 |
| `변형 lease 상실` ERROR 급증 | 발송 중 폐기/취소 경합이 실제로 일어나고 있다 | 정상 동작(막고 있는 것). 다만 빈도가 높으면 운영 플로우 점검 |
| `원본 폐기 역전 실패` ERROR | **고객 쿠폰이 폐기된 채 남아 있다** | 🚨 즉시 대응. 로그의 `orderDeliveryId` 로 수동 복구 |
| `tip 무력화 실패` ERROR | 배치가 유령 tip 을 집어 PIN 을 발급할 수 있다 | 🚨 즉시 대응. 해당 `orderDeliveryId` 의 `status`/`coupon_status` 확인 |

### 신규 에러코드

**`3010` (HTTP 409 CONFLICT)** — 외부 API. "처리 중인 주문".
`3005`/`3006`/`3007` 이 **영구 거절**인 것과 달리 **일시적 거절**이며, 파트너는 잠시 후 재시도하면 됩니다.
`docs/external-api-guide.md` 에 반영되어 있습니다.

---

## 4. 이 lease 가 막는 것 (요약)

재발행(`execHistory` DISCARD_REISSUE)은 되돌릴 수 없는 외부 부작용 3개
(협력사 취소 → 핀 발급 → 문자 발송)를 순차 실행하므로 `@Transactional` 로 감쌀 수 없습니다.
그 수 초 동안 다른 액터가 같은 행에 진입하면:

- **폐기/외부취소가 들어오면** → 협력사에서 핀이 죽고 환불까지 나간 뒤, 재발행이 그 핀을 고객에게 발송
- **발송배치가 집어가면** → PIN 이중 발급 + 문자 2통 + SSG 행사 잔액 이중 차감

`mutation_claimed_at` 은 이 구간을 "진행중" 으로 표시해 다른 액터의 진입을 거절합니다.
lease 를 존중하는 곳: `execDiscard` / `bulkDiscard` / `execPinStatusModify` / CS `reSend` /
외부 `cancelOrder` / 외부 `resendOrder` / 발송배치 `claimWaitDeliveries`.
