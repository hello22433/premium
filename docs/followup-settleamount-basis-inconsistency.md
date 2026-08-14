# [후속/별도 티켓] settleAmount basis 불일치 (197-16 부분취소 작업 중 발견)

> 이 문서는 197-16(예약 발송건 부분취소) 작업 중 발견한 **범위 밖 기존 이슈**를 추적한다.
> PR 리뷰/코멘트 시 이 파일을 참조할 것. 부분취소 자체는 이 이슈와 무관하게 정상 동작한다.

## 무엇이 문제인가

`order.settleAmount` 가 라이프사이클 경로마다 **서로 다른 basis** 로 설정된다.

| 경로 | 코드 | settleAmount 값 | 포인트 |
|---|---|---|---|
| 발송확정 (wallet, 최신) | `order.service.ts` deliveryConfirmed → `= allocation.payableSettlementAmount` | `(gross − 포인트) + 카드할증(gross − 포인트)` | **제외** |
| 정산수정 (살아있는 경로) | `createOrderSettle`/`updateOrderSettle` → `= calculateOrderSettlementAmount(...)` | `gross + 카드할증(gross)` | **포함** |

- `payableSettlementAmount` (payment-allocation.service.ts:174): `cardSurchargeBase = grossSettlementAmount − pointUsedAmount` — 할증 base 에서 포인트를 뺀다.
- `calculateOrderSettlementAmount` (settle-fee.util.ts:144): `gross` 에 할증 — 포인트를 모른다.

포인트를 쓴 주문에서 두 값은 **(포인트값 + 할증율 × 포인트)** 만큼 다르다.

## 왜 문제가 될 수 있나 (미확정)

정산수정의 `difference = order.settleAmount − calculateOrderSettlementAmount(...)` 로직은
`order.settleAmount` 가 **자기와 같은 basis(gross 포함)** 라고 가정한다. 그런데 발송확정이
payable basis(포인트 제외)로 저장해 뒀다면, 포인트 주문을 발송확정 후 정산수정할 때
`difference` 가 포인트값만큼 어긋나 **잔액을 오조정**할 수 있다.

**단, 실제 발생 여부는 미확정이다.** 확인 필요 항목:
1. 정산수정 difference 블록(`order.service.ts` createOrderSettle:3214 / updateOrderSettle:3340)이
   **wallet-managed 주문에도 실제로 도는가?** (`if (order.isNewBillingFlow)` 게이트 — isNewBillingFlow 와
   isWalletManaged 의 관계 확인 필요)
2. 돈다면, 포인트 쓴 주문에서 정말 포인트값만큼 잔액이 오조정되는가? (실 DB/시나리오 재현)
3. wallet 주문의 정산수정이 difference 가 아니라 재-allocation 경로로 가야 하는 것은 아닌가?

→ **정산 담당 확인 + 별도 티켓.** 발송확정·정산수정의 settleAmount basis 를 한쪽으로 통일하는 게
근본 해법(payableSettlementAmount 로 통일하려면 difference 로직도 payable basis 로 바꿔야 함).

## 197-16 부분취소는 왜 안전한가

부분취소(`partialDeliveryCancel`, order.service.ts)는 잔여분 settleAmount 를
`calculateOrderSettlementAmount` 로 재계산해 덮는다. **정산수정 difference 블록이 비교 기준으로 쓰는
바로 그 함수** 라, 부분취소 후 정산수정을 하면 `difference = 0` 이 되어 부분취소발 이중환불이 없다.

여기서 wallet 관례(payableSettlementAmount)가 아니라 calculateOrderSettlementAmount 를 쓴 것은 의도적이다
— 이중환불을 일으키는 경로(difference 블록)와 basis 를 일치시키는 것이 목적이기 때문이다.
basis 통일은 위 별도 티켓에서 정산수정·발송확정을 함께 정리하는 것이 맞다.
자세한 근거는 `order.service.ts` partialDeliveryCancel 의 settleAmount 재계산 지점 주석 참조.
