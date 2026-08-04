# 프리플라이트 — ssg_issue_log 후보 유일성 UNIQUE 도입

대상 마이그레이션: `sql/migrations/20260804_ssg_issue_log_unique_keys.sql`
계획: `docs/plans/2026-08-04-ssg-issue-log-unique-typed-collision.md`

## 왜 자동 정리를 하지 않는가

`ssg_issue_log` 는 orphan 복구의 진실 원천이다. `partner.company.extern.service.ts` 의 후보 분류 경로가 이 로그로 이미 SSG에 등록된 PIN을 찾아 재사용한다. 단순 중복으로 보이는 행도 복구 후보이거나 이중 발급 사고의 증거일 수 있다.

따라서 **마이그레이션은 검사만 하고, 중복이 하나라도 있으면 실패한다.** 정리는 아래 판정을 거쳐 승인된 대상만 별도로 수행한다.

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
