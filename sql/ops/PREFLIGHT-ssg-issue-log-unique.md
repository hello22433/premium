# 프리플라이트 — ssg_issue_log 후보 유일성 UNIQUE 도입

대상 마이그레이션: `sql/migrations/20260804_ssg_issue_log_unique_keys.sql`
계획: `docs/plans/2026-08-04-ssg-issue-log-unique-typed-collision.md`

## 왜 자동 정리를 하지 않는가

`ssg_issue_log` 는 orphan 복구의 진실 원천이다. `partner.company.extern.service.ts` 의 후보 분류 경로가 이 로그로 이미 SSG에 등록된 PIN을 찾아 재사용한다. 단순 중복으로 보이는 행도 복구 후보이거나 이중 발급 사고의 증거일 수 있다.

따라서 **마이그레이션은 검사만 하고, 중복이 하나라도 있으면 실패한다.** 정리는 아래 판정을 거쳐 승인된 대상만 별도로 수행한다.

## 0. 배포 순서 (먼저 확인)

이 DDL 은 **애플리케이션의 typed 충돌 분류가 이미 배포된 뒤에만** 적용한다. 순서가 뒤집히면 UNIQUE 위반이 raw `QueryFailedError` 로 올라가 일반 발급 실패로 뭉개지거나 기존 PIN 복구 분기로 오진입해 다른 고객의 PIN 이 발송 건에 부착될 수 있다.

배포 대상 앱에 `SsgIssueLogKeyCollisionError` 가 포함되어 있는지 확인한 뒤 진행한다.

## 0-1. 인덱스 현황 확인

마이그레이션은 `idx_ssg_issue_log_bar_code` / `idx_ssg_issue_log_personal_code` 를 DROP 한다. 실제 DB 의 인덱스명이 다르면 ALTER 가 실패한다(부분 적용은 아니므로 안전하지만 헛도는 작업이 된다).

```sql
SHOW INDEX FROM ssg_issue_log;
```

확인 항목:

- `idx_ssg_issue_log_bar_code` / `idx_ssg_issue_log_personal_code` 가 실제로 존재하는가 (없으면 마이그레이션의 DROP 절을 실제 이름으로 교체하거나 제거)
- `uq_ssg_issue_log_bar_code` / `uq_ssg_issue_log_personal_code` 가 이미 있는가 (있으면 적용 완료 상태)
- `bar_code` / `personal_code` 가 다른 복합 인덱스의 선두 컬럼으로 쓰이는가

## 0-2. 규모 확인

```sql
SELECT COUNT(*) AS rows_total FROM ssg_issue_log;
```

InnoDB 에서 보조 UNIQUE 인덱스 추가는 **테이블을 재구성하지 않는다**(MySQL 8 online DDL: in-place, no table rebuild, 동시 DML 허용). 인덱스 DROP 도 마찬가지다. 따라서 이 마이그레이션은 `ALGORITHM=INPLACE, LOCK=NONE` 으로 수행한다.

마이그레이션이 두 절을 명시하는 이유는 속도가 아니라 **안전장치**다. 어떤 이유로든 in-place 가 불가능하면 MySQL 이 조용히 COPY 알고리즘으로 떨어져 쓰기를 막는 대신, ALTER 가 즉시 실패한다. 실패하면 그 원인을 확인한 뒤 두 절을 빼고 점검 창에서 재시도한다.

행 수는 소요 시간 추정용으로만 확인한다.

## 1. 중복 검사

```sql
-- bar_code 중복
SELECT bar_code,
       COUNT(*)                          AS row_count,
       COUNT(DISTINCT order_delivery_id) AS delivery_count,
       GROUP_CONCAT(id ORDER BY id)      AS log_ids
  FROM ssg_issue_log
 GROUP BY bar_code
HAVING COUNT(*) > 1;

-- personal_code 중복
SELECT personal_code,
       COUNT(*)                          AS row_count,
       COUNT(DISTINCT order_delivery_id) AS delivery_count,
       GROUP_CONCAT(id ORDER BY id)      AS log_ids
  FROM ssg_issue_log
 GROUP BY personal_code
HAVING COUNT(*) > 1;
```

두 쿼리 모두 0행이면 마이그레이션을 그대로 실행한다.

## 2. 결과 판정

### `delivery_count > 1` — 이중 발급 사고

서로 다른 배송 건이 같은 PIN을 보유한 상태다. 이 마이그레이션으로 정리하지 않는다. **삭제 금지.**

각 그룹에 대해 다음을 확인하고 건별로 처리 방침을 승인받는다.

```sql
SELECT l.id, l.order_delivery_id, l.bar_code, l.personal_code,
       l.event_no, l.event_seq, l.ssg_event_id, l.inserted_at,
       d.status, d.bar_code AS delivery_bar_code, d.actual_send_at
  FROM ssg_issue_log l
  JOIN order_delivery d ON d.id = l.order_delivery_id
 WHERE l.id IN (/* 위 log_ids */)
 ORDER BY l.id;
```

추가로 SSG 측 실제 등록 여부(GetSsgTry / GetSsgStatus)를 후보별로 조회해 어느 배송 건이 실제 등록분인지 확정한다.

### `delivery_count = 1` — 같은 배송 건의 중복 로그

자동으로 "최신 1건 보존" 하지 않는다. 아래를 확인한 뒤 승인된 대상만 정리한다.

```sql
SELECT id, order_delivery_id, bar_code, personal_code,
       event_no, event_seq, ssg_event_id, inserted_at,
       expire_at, encourage_at, coupon_num
  FROM ssg_issue_log
 WHERE order_delivery_id = /* 대상 */
 ORDER BY id;
```

확인 항목:

- 두 행의 `bar_code` / `personal_code` 가 실제로 동일한가
- `event_no` / `event_seq` 가 다른가 (다르면 서로 다른 행사에 대한 시도 — 복구 후보로 둘 다 의미가 있다)
- `inserted_at` 간격과 그 사이의 발송 시도 이력
- SSG 조회 결과상 어느 쪽이 등록된 후보인가

등록 후보를 지우면 orphan 복구가 그 PIN을 되찾지 못한다.

## 3. 정리 후 재검사

정리를 수행했다면 §1 을 다시 실행해 0행을 확인한 뒤 마이그레이션을 진행한다.

## 4. 실행 기록

| 일자 | 대상 | 행 수 | §1 bar_code | §1 personal_code | §0-1 인덱스명 | 판정 |
|---|---|---|---|---|---|---|
| 2026-08-04 | 개발 | 0 | 0행 | 0행 | `idx_*` 2개 존재, `uq_*` 없음 | 적용 가능 |
| 2026-08-04 | 배포 | 47,558 | 0행 | 0행 | `idx_*` 2개 존재, `uq_*` 없음 | 적용 가능 (앱 배포 후) |

엔진은 MySQL 8 (`SHOW INDEX` 에 `Visible` / `Expression` 컬럼 존재). 개발 DB 는 행이 0 이라 마이그레이션 문법만 확인 가능하고 데이터 무결성 검증은 되지 않는다. 실 제약 동작은 `src/delivery/application/ssg-insert-state.unique-collision.db-integration-test.ts` 가 전용 테이블에서 검증한다.
