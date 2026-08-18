# 후속: 레거시 미러 금액이 "실제 복구액" 과 분리돼 있다 (자금, 3경로)

> 상태: **별도 티켓 필요**. 197-16 범위 밖 — 이 브랜치가 만든 문제가 아니고, 셋 다 다른 경로/모듈이다.
> 근거: 197-16 리뷰의 파급범위 조사(RefundEventResult 소비자 전수 + `*RestoredAmount` 역산 지점 전수).
> 197-16 은 **부분취소 경로에서만** 이 결함을 닫았다(관리자 리뷰 P1-2). 같은 결함이 아래 3곳에 남아 있다.

## 결함의 공통 형태

지갑(`wallet_account` / `order_payment_allocation`)이 정본이고, 레거시 컬럼
(`user_company.balance`, `user.all_settle_amount`)은 그 **미러**다. 미러에 적립할 금액을
"이번 환불이 실제로 복구한 액수" 가 아니라 **다른 근거로 따로 계산**하면 둘이 어긋난다.

어긋나는 방식은 두 가지다.

1. **락 밖에서 읽은 allocation 으로 잔여를 역산** — 읽기와 실제 복구(락 안) 사이에 다른 환불이
   커밋되면 역산값이 과대해진다 → 미러 과다적립.
2. **복구 재원을 구분하지 않음** — 포인트로 복구된 몫까지 예치금에 적립하거나, 차감 총액을
   그대로 되돌린다 → 같은 돈이 두 곳에 잡힌다.

197-16 이 쓴 해법은 `RefundEventResult.restoredByResource` 다 —
**락 안에서** `(복구 후 누계 − 복구 전 누계)` 를 재원별로 계산해 반환하고, 미러는 그 값만 쓴다.
아래 3건은 그 반환값을 쓰면 대부분 그대로 해소된다.

---

## ① 전체취소 (`order.service.ts` — deliveryCancel 의 wallet 분기)

가장 우선순위가 높다. **197-16 이 고친 것과 정확히 같은 창이 같은 엔드포인트의 옆 분기에 남아 있다.**

```
allocation 읽기            ← 락 없음
잔여 = used - restored     ← 이 시점 스냅샷
releaseConfirmation(...)   ← 여기서 비로소 wallet/allocation FOR UPDATE, 락 안에서 다시 계산(더 작은 값)
company.balance += 위의 stale 잔여   ← 과다적립
user.allSettleAmount -= ...
```

- 창 안에 CS 폐기환불·발송실패 환불이 커밋되면 `*RestoredAmount` 가 올라가 지갑은 남은 몫만 복구하는데,
  미러는 stale 한 큰 값을 적립한다. CS 가 이미 반영한 몫이 회사 예치금/여신에 **한 번 더** 들어간다.
- 부수: 미러 갱신이 `읽은 값 += 델타` 후 `save()`/`update()` 다. 부분취소는 DB 측 증감식으로 lost update 를
  막았지만 전체취소는 그대로다. `save(company)` 는 stale 스냅샷 전체 덮어쓰기이기도 하다.

**착수 시**: `ReleaseConfirmationResult` 에 재원별 복구액을 추가한다(`restoredByResource` 와 같은 형태,
락 안에서 계산). 그게 없으면 호출부는 계속 역산할 수밖에 없다 — 이게 구조적 원인이다.
미러 갱신은 부분취소와 같이 DB 증감식으로 바꾼다.

## ② CS 정산완료 폐기환불 — 포인트 이중계상 (`customer.service.service.ts`)

```
restoreAmount = walletRefund.totalRefundedAmount     // = depositRefundAmount + pointRefund.restored
...
user_company.balance += restoreAmount
user.balance        += restoreAmount
```

포인트는 이미 `point_grant.remaining_amount` 로 복구된 뒤인데, 그 몫이 회사 예치금에 **또** 더해진다.
정확한 값은 `restoredByResource.deposit` 이다.

**착수 시**: `totalRefundedAmount` → `restoredByResource.deposit` 으로 교체. 사실상 한 줄이지만
`restoreAmount` 가 그 아래 `refundLedgerService.claimWithManager` 의 `refundAmount` 로도 흘러가므로,
원장에 남길 금액이 "예치금 복구액" 인지 "총 복구액" 인지 정책을 먼저 정할 것. **그 판단 때문에
197-16 에서 자동 수정하지 않았다.**

## ③ 외부 API 환불 미러 (`external.api.service.ts`)

```
UPDATE user_company SET balance = balance + ?    ← allocation.depositUsedAmount (원 차감 전액)
UPDATE user SET all_settle_amount = ... - ?      ← creditUsedAmount + creditExcessAmount
```

- `allocation` 은 락 없이 읽고, `refund()` 는 그 뒤에 락을 잡는다(①과 같은 창).
- `refund()` 의 복구 우선순위는 포인트 → 신용초과 → 여신 → 예치금이다. 포인트를 쓴 주문이면
  **실제 복구된 예치금 < `depositUsedAmount`** 인데 미러는 항상 전액을 적립한다.
- 같은 주문에 이미 다른 환불이 있었으면 `refund()` 는 잔여만 복구하는데 미러는 여전히 전액이다.

**착수 시**: `restoredByResource.deposit / creditUsed / creditExcess` 로 교체.

---

## 착수 전 확인

- 세 경로 모두 **돈**이고 되돌리기 어렵다. 코드 수정 전에 운영 DB 에서 실제 괴리가 발생한 주문이
  있는지 먼저 조회할 것(지갑 잔액 vs `user_company.balance` 대사). 괴리가 이미 쌓여 있다면
  코드 수정과 **데이터 보정이 별개 작업**으로 필요하다.
- ①은 197-16 과 같은 엔드포인트라 함께 가는 게 자연스러웠으나, PR 범위를 지키기 위해 분리했다.
  다음 티켓에서 가장 먼저 다룰 것.
