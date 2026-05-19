# SSG 잔액 정합 운영 점검 SQL

plans/ssg-balance-refactor.md PR5 (운영 검증).

## 목적

PR1~PR3 머지 후 SSG 행사 잔액 / 고객 환불 / state machine 정합이 유지되는지 주기 점검.
DEFERRED 케이스, legacy backfill 잔존, race 결과 등을 운영 측에서 감시한다.

## 점검 SQL 목록

| 파일 | 목적 | 권장 주기 |
|---|---|---|
| `01-deferred-rows.sql` | `ssg_balance_settled = false` 인 ledger row 추적 (SSG 보정 DEFERRED) | 1시간 |
| `02-event-balance-recalc.sql` | `event_balance` vs `event_price - SUM(deduct) + SUM(refund)` 차이 검출 | 1일 |
| `03-orphan-fail-rows.sql` | SSG 실패 인데 ledger / refundedAt 누락된 row 탐지 | 1일 |
| `04-state-distribution.sql` | `order_delivery_ssg_insert_state` state 분포 + ATTEMPTED 잔여 알림 | 1시간 |

## 알림 임계값 (제안)

- `01-deferred-rows.sql` row > 0 → 운영팀 즉시 알림. resolver DEFERRED 가 누적되면 SSG 잔액 정합 깨질 수 있음.
- `02-event-balance-recalc.sql` 차이 > 0 → 즉시 점검. 잔액 산식 어긋남.
- `03-orphan-fail-rows.sql` row > 0 → 1일 이내 점검. ledger 누락 또는 비정상 흐름.
- `04-state-distribution.sql` ATTEMPTED row 가 30분 이상 잔존 → orphan resolver 호출 확인.

## 실행 방법

```bash
mysql --user=ops --password --database=epopkon < qa/ssg-balance-check/01-deferred-rows.sql
```

또는 운영 모니터링 대시보드 (Metabase 등) 에 등록.

## 참고

- 본 SQL 은 reconciliation 점검용. 자동 보정 안 함 (데이터 보정은 운영 결정).
- 결과가 비정상 패턴이면 `[SSG_REFUND] DEFERRED`, `[RESEND] SSG 잔액 보정 미완료` 로그와 교차 확인.
