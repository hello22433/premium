# 후속: SSG 주문 발송건별(부분) 취소 지원

> 상태: **차단(fail-closed)** — 현재 SSG 주문은 부분취소 시 400. 별도 티켓에서 착수.
> 관련 티켓: 197-16(예약건 부분취소 + 예치금/여신 복구)의 후속.
> 차단 위치: `src/order/application/order.service.ts` `partialDeliveryCancel` (SSG 400 가드).

## 왜 이번 티켓에서 빼는가

197-16 일반(비SSG) 부분취소는 완결·리뷰까지 끝나 배포 가능하다. SSG 부분취소는
**신규·비가역 로직**(행사잔액 발송건별 복구)이 필요하고 **운영 검증 데이터가 없어**(운영 DB 접속 부재,
개발 DB엔 실제 SSG 지갑/확정 흐름이 돌아간 적 없음) 이번 범위에서 분리한다.

## 코드로 확인된 SSG 자금 모델 (DB 무관, 2026-07-23 확정)

SSG 주문은 **두 곳에서 돈이 빠진다**:

| 단계 | 행사잔액 (신세계 캠페인 예산) | 지갑 (고객사 예치금/여신) |
|---|---|---|
| 발송요청 | `deductEventBalanceMultiple`(가차감, isTemporary=true) | 신흐름=안 함 / 구흐름=여기서 balance 차감 |
| 발송확정 | `confirmEventBalance`(temp→확정) | `persistAllocation`(신흐름 WALLET) 또는 `balance`/`allSettleAmount`(구흐름) |

- wallet/legacy 분기는 **SSG로 게이트되지 않는다** — SSG도 일반 주문과 동일하게 지갑을 차감한다
  (`order.service.ts` 확정 경로). SSG 전용은 `confirmEventBalance` 한 줄뿐이고, 지갑 차감에 **더해서** 실행.
- 업무 해석: **행사잔액 = 쿠폰 액면가(신세계 부담)**, **지갑 차감 = 발송/정산 수수료(고객사 부담)**.
- 과거 "개발 DB에서 SSG 51건 지갑 allocation 0건" 관측은 **개발 DB가 실제 SSG 흐름을 돌린 적 없어 생긴 착시**.
  코드 기준으로 SSG는 지갑을 반드시 차감한다.

### 기존 전체취소는 이미 둘 다 복구한다 (참조 패턴)

`partialDeliveryCancel` 이 아니라 **전체 주문취소** 경로(`order.service.ts` 취소 블록)는 이미:

```
if (order.type === SSG) restoreEventBalance(order.id)   // 행사잔액 전량 복구
if (isWalletManaged)  releaseConfirmation(...)          // 지갑 환불(신흐름)
else if (refundAmount>0) balance/allSettleAmount 복구    // 레거시 환불(구흐름)
```

부분취소는 이 패턴을 **취소 대상 발송건 범위로 좁혀** 재현하면 된다.

## 왜 지금 막는가 (기술 근거)

부분취소의 두 축 중 **지갑은 이미 커버**되지만(부분환불 경로가 발송건별 allocation line 을 되돌림),
**행사잔액은 발송건별 복구가 불가능**하다:

- `ssg_event_amount_history` 차감 이력이 **(주문, 행사) 합산 1행**으로 기록되고
  `order_delivery_id` 귀속이 없다 → 취소된 발송건 **몫을 역산할 근거가 없다**.
- 근거 없이 금액을 안분해 복구하면 **행사잔액이 부풀 수 있고**, 행사잔액은 **상한 검증이 없어**
  과다 적립을 되돌리기 어렵다(비가역 자금 리스크).

## 착수 시 해야 할 일 (설계 스케치)

0. **컬럼/엔티티 되살리기** (이 티켓에서 빠졌음 — 197-16 리뷰 LOW 반영).
   `ssg_event_amount_history.order_delivery_id` 컬럼 + `(order_id, order_delivery_id)` 인덱스
   마이그레이션과 엔티티 필드는 **197-16 PR 에서 제거**했다. 쓰는 코드가 없는데 앱 배포 선행
   마이그레이션만 1개 늘어나기 때문이다. 원본은 커밋 `cb5da68` 의
   `sql/migrations/20260722_add_ssg_event_amount_history_delivery.sql` 과
   `src/entity/ssg.event.amount.history.entity.ts` 에 그대로 있으니 되살려 쓰면 된다.
   ★ 엔티티가 컬럼을 선언한 채 마이그레이션이 안 돌면 그 테이블 조회가 전부 Unknown column 으로
     깨진다. **둘을 반드시 같이** 넣고, 마이그레이션을 앱 배포보다 먼저 적용할 것.

1. **차감을 발송건별로 기록**: `deductEventBalanceMultiple` 이 발송건(order_delivery_id)별 1행씩 남기도록.
   - 최종 `eventBalance` 는 현행(합산 차감)과 **동일**해야 함(러닝 밸런스).
   - 재발행/유효기간변경(`restoreTemporaryEventBalance` → 재차감) 경로도 발송건별 기록을 승계해야 함.
2. **범위 복구**: `restoreEventBalance(orderId, deliveryIds?)` 로 특정 발송건 몫만 복구.
   - `order_delivery_id` **NULL 인 옛 행(귀속 없음)** 은 안분 근거가 없으므로 **fail-closed**(그 주문은 부분취소 400 유지).
3. **부분취소 SSG 분기**: 400 가드 제거 → `restoreEventBalance(orderId, canceledDeliveryIds)` 호출 +
   기존 부분환불(지갑) 그대로.
4. **범위 결정(권장 ⓑ)**: 1차는 **수정 이력 없는 단순 SSG 주문만** 허용(재차감/유효기간변경 이력 있으면 fail-closed).
5. **운영 검증**: 착수 전 정산 담당에게 SSG 결제 모델(고객사가 지갑에서 무엇을·얼마를 부담하는지) 확인 후
   실 데이터로 신흐름/구흐름 분포 확인.
6. **행사잔액 화면 집계 동반 수정 (필수)**: `ssg.event.service.ts` 의 행사잔액 집계
   (`getSsgBalanceCheckForOrder` 계열, 대략 L215~/L384~)는 "발송대기" 를 **주문 상태**(`isOrderWait` =
   DELIVERY_REQUEST/REVIEW_COMPLETE/DELIVERY_CONFIRMED)로만 판정하고 발송건 `status=CANCEL` 을 보지 않는다.
   부분취소는 주문을 DELIVERY_CONFIRMED 로 남기므로, SSG 부분취소를 열면 **취소된 발송건이 "발송대기" 에
   영구 집계**되어 행사잔액 화면이 0 으로 수렴하지 않는다(취소분이 계속 대기로 잡힘). 취소건은 대기·완료
   어느 쪽에도 넣지 않도록 `orderDelivery.status === CANCEL` 제외를 함께 넣어야 한다.

## 기준선 보호

`src/ssg_event/application/ssg.event.service.deduct-restore-baseline.spec.ts` 가 **현행 차감(합산 1행)/
복구(전량)** 동작을 못 박아 둔다. 위 1~2를 구현할 때 이 스펙이 깨지면 동작이 바뀐 것 — 의도된 변경인지 확인용.
