# SSG PIN 생애 유일성 — ssg_issue_log UNIQUE + typed 충돌 + 후보 재시도

기준 커밋: `develop` @ `71154e7c` (이 문서의 모든 라인 번호는 이 커밋 기준)

## 1. 문제

SSG PIN 후보의 중복 검사가 **비원자적**이다.

- `partner.company.extern.service.ts:756-758` — 로컬 중복 검사가 `ssgIssueLogRepository.findOne` (단순 SELECT)
- `entity/ssg.issue.log.entity.ts:23,27` — `bar_code` / `personal_code` 인덱스가 **non-unique** (`idx_*`)
- `delivery/application/ssg-insert-state.service.ts:121` — 로그 INSERT를 막는 제약이 없음
- `partner.company.extern.service.ts:104` `withSsgMutex` 는 **프로세스 로컬**이라 다중 노드에서 무효

→ SELECT 통과 시점과 INSERT 시점 사이에 다른 프로세스/노드가 같은 PIN을 생성하면 둘 다 통과하고 두 행이 모두 저장된다. SSG Oracle 측에도 unique 제약이 없다(`ssg.issue.log.entity.ts` 주석 참조). 결과는 **동일 PIN의 이중 발급**.

## 2. 해결 방향

1. `ssg_issue_log.bar_code` / `.personal_code` 에 **UNIQUE 제약**을 걸어 DB를 유일성의 단일 권위로 만든다.
2. 그 제약 위반을 **typed 예외**로 좁게 분류한다.
3. 기존 `PartnerCompanyExternService.issue()` 의 PIN 후보 루프가 그 예외를 받아 **다음 후보로 진행**한다.

`issue()` 내부에서 처리하므로 6개 호출자(`order.receive.service.ts:271,1189`, `delivery.batch.service.ts:1483,1989`, `customer.service.service.ts:2850`, `external.api.service.ts:1064`)는 **변경하지 않는다.** router / coordinator / REQUIRES_NEW adapter / AST allowlist / `pin_issue_command` 확장은 모두 범위 밖이다.

### 왜 adapter가 불필요한가

`markAttempted()` 는 `ssg-insert-state.service.ts:91` 에서 이미 `@Transactional({ propagation: REQUIRES_NEW })` 다. 로그 INSERT가 실패하면 그 REQUIRES_NEW 트랜잭션만 원자적으로 롤백되며, 같은 트랜잭션에서 수행한 state row 삽입/전이도 함께 되감긴다(→ 재시도 시 state는 충돌 이전 값). 충돌 원자성은 이미 확보되어 있다.

반대로 `issue()` 전체를 `REQUIRES_NEW` 로 감싸면 `partner.company.extern.service.ts:848` 의 SSG HTTP 호출이 끝날 때까지 DB 트랜잭션을 붙잡게 된다. 순손실이므로 채택하지 않는다.

## 3. 필수 제약 (착수 조건)

### 3-1. 후보 상한은 전체 5회 — 중첩 금지

기존 생성 루프(`:752-791`)를 유지한 채 `:750-843` 바깥에 재시도 루프를 씌우면 충돌마다 내부 5회가 다시 돌아 **최대 25개 후보**가 생성된다. 금지한다.

생성 → 로컬 조회 → `getTry` → 트랜잭션 ID·만료일 산출 → **본문 산출** → `markAttempted` 를 **단일 5회 후보 루프**로 재구성한다.

- `SsgIssueLogKeyCollisionError` 만 `continue`
- 그 외 모든 오류는 즉시 전파 (특히 `getTry` 실패는 기존대로 즉시 throw — 중복 여부 불명이므로)
- `ssgIssue.issue()` 는 `markAttempted` 성공 이후에만, 루프 밖에서 1회 호출
- 5회 소진 시 기존 `:793` 과 동일한 의미의 실패로 종결

### 3-2. 후보별 재산출 범위

충돌 후 다음 후보로 넘어갈 때 **아래를 전부 후보 단위로 재산출**한다.

| 대상 | 근거 |
|---|---|
| `barCode`, `personalCode` | `:749` 생성 게이트가 `if (!orderDelivery.barCode \|\| !orderDelivery.personalCode)` 이므로 무효화하지 않으면 같은 후보를 재사용한다. 선례: `:645-646` |
| `ssgTransactionId` | `:801` — 후보마다 새 trId |
| `expireAt` | `:802` — 무조건 재산출. `attemptPayload` 와 SSG 본문에 실린다 |
| `encourageAt` | `:806-809` 은 `encourageDay` 가 있을 때만 대입했다. `expireAt` 이 무조건 재산출되므로, 이전 시도(실패/고아/충돌 후보)가 남긴 값이 남으면 **옛 `expireAt` 기준 알림일이 새 후보에 붙는다.** `encourageDay` 가 없으면 명시적으로 `null` 로 지운다 |
| `textForSsg` | **`sms.ssg.template.ts:47-50` 이 `personalCode` / `barCode` / `expireAt` 를 본문에 직접 박는다.** 재산출하지 않으면 옛 PIN이 적힌 본문을 SSG로 보낸다 |

이 재산출은 **`needsInsert === true` 경로에만** 적용된다. 기존 PIN 재사용 경로(`needsInsert === false`)는 `markAttempted` 를 호출하지 않으므로 충돌 자체가 발생하지 않는다.

근거 불변식: `:609` 에서 `needsInsert = true` 로 시작하고, `:610` 블록은 기존 PIN이 REGISTERED면 `needsInsert=false`, PROCESSING이면 throw, 그 외에는 `:645-646` 에서 PIN을 null 로 만든다. `:657` 블록도 후보 재사용 시 `needsInsert=false` 로 내린다. 따라서 **`needsInsert === true` 이면 `:749` 시점에 PIN은 항상 비어 있고 생성 루프에 진입한다.**

### 3-3. 충돌 분류는 좁고 견고하게

`errno === 1062` 만으로는 부족하다. 다음을 모두 만족할 때만 typed 변환한다.

- driver error의 `code === 'ER_DUP_ENTRY'`
- 위반 키 이름이 `uq_ssg_issue_log_bar_code` 또는 `uq_ssg_issue_log_personal_code`

키 이름은 엔진별 포맷 차이를 모두 수용한다.

```
MySQL 8    : Duplicate entry '...' for key 'ssg_issue_log.uq_ssg_issue_log_bar_code'
MariaDB 10 : Duplicate entry '...' for key 'uq_ssg_issue_log_bar_code'
```

그 외 모든 unique 충돌과 DB 오류는 **원본 오류 그대로 전파**한다.

`MarkAttemptedResult` 에 충돌 상태를 추가하지 않는다. 충돌은 정상 결과가 아니라 예외이므로 기존 `TRANSITIONED` / `SKIPPED_ACTIVE` / `SKIPPED_TERMINAL` 계약을 유지한다.

### 3-4. 기존 중복 데이터 — 자동 정리 금지

`ssg_issue_log` 는 orphan 복구의 진실 원천이다(`partner.company.extern.service.ts:657-721` 이 이 로그로 후보를 분류·재사용한다). 단순 중복으로 보여도 복구 후보와 사고 증거를 지울 수 있다.

**마이그레이션은 검사만 하고, 중복이 하나라도 있으면 명시적으로 실패한다.** 자동 정리는 하지 않는다.

- `d > 1` (서로 다른 `order_delivery_id` 가 같은 코드 보유) = **이미 발생한 이중 발급 사고**. 개별 판정 대상. 삭제 금지.
- `d = 1` (같은 배송건의 중복 로그) = 두 로그의 `bar_code` / `personal_code`, SSG 조회 결과, `event_no` / `event_seq`, `inserted_at` 을 확인한 뒤 승인된 대상만 별도 스크립트로 정리한다.

검사 SQL은 `sql/ops/` 프리플라이트 문서에 둔다.

## 4. 변경 목록

| # | 파일 | 변경 |
|---|---|---|
| 1 | `src/partner_company_extern/infra/ssg.issue.ts` | `SsgIssueLogKeyCollisionError` 추가 |
| 2 | `src/delivery/application/ssg-insert-state.service.ts` | 로그 INSERT 충돌을 §3-3 규칙으로 typed throw |
| 3 | `src/entity/ssg.issue.log.entity.ts` | `idx_ssg_issue_log_bar_code` / `_personal_code` → `uq_*` unique |
| 4 | `sql/ops/`, `sql/migrations/` | 중복 프리플라이트 + UNIQUE DDL |
| 5 | `src/partner_company_extern/application/partner.company.extern.service.ts` | §3-1 / §3-2 단일 후보 루프 |

머지 순서는 **2 → 3·4** 를 지킨다. UNIQUE DDL이 typed 분류보다 먼저 들어가면 raw `QueryFailedError` 가 일반 실패로 뭉개지거나 기존 PIN 복구 분기로 오진입해 **남의 PIN이 이 발송 건에 부착**될 수 있다.

## 5. 테스트

- `bar_code` / `personal_code` 각각의 `ER_DUP_ENTRY` 만 typed 변환
- 두 인덱스 외의 `ER_DUP_ENTRY` 및 일반 DB 오류는 원본 그대로 전파
- 1차 후보 충돌 → 2차 후보로 SSG INSERT 성공
- 충돌한 후보에 대해 `ssgIssue.issue()` 호출 0회
- 후보 전환 시 `ssgTransactionId` / `expireAt` / SSG 본문이 새 후보 기준으로 재산출됨
- 후보 5회 소진 시 실패 종결, 벤더 호출 0회
- 실제 UNIQUE 제약 기반 동시 INSERT 통합 테스트

## 6. 범위 밖

일반 쿠폰(galaxia / gsmbiz / giftiel / giftiShow / culture / daou) 발급 경로, 6개 `issue()` 호출자, `MarkAttemptedResult` 계약, `withSsgMutex` 제거, `pin_issue_command` 스키마 확장, lineage 테이블, AST/CI allowlist.

`withSsgMutex` 는 유지하되 다중 노드 안전 권위가 아님을 주석으로 명시한다. 유일성 권위는 UNIQUE 제약이다.
