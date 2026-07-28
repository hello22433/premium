/**
 * 컷오버 대상 legacy 진입점 인벤토리.
 * plans/프리미엄_발송실패_재발송_구상.md §9 「기존 경로 컷오버·마이그레이션 계약」 표(2026-07-27 코드 실측본).
 *
 * 전환 마크(`delivery_workflow.cutover_migrated_at IS NOT NULL`)를 가진 건은 이 진입점들로 처리하지 않는다.
 * 기존 `claimedAt` 토큰 모델과 신규 Level A 슬롯 모델이 서로를 모르기 때문에, 둘이 같은 `order_delivery`
 * 를 동시에 잡으면 이중 발송·중복 발급·중복 환불이 뚫린다(§9 단일 동시성 모델 원칙).
 *
 * 표 #11 `RefundPoolService.refund` / `refundSettledDiscardToDeposit` 은 **진입점이 아니라 하위 실행기**라
 * 이 enum 에 없다. 그 대신 "5~8 외 신규 호출자 추가 금지"를 호출자 화이트리스트 회귀 테스트로 고정한다
 * (`refund-pool.caller-allowlist.spec.ts`).
 */
export enum LegacyDeliveryEntryPoint {
  /** #1 DeliveryBatchService.processOneDeliveryInternal / oneSend — 배치 최초 발송·보류 재발송 */
  BATCH_SEND = 'BATCH_SEND',
  /** #2 PartnerCompanyExternHistoryService.resendFailedDelivery — 발송실패내역 수동 재발송 */
  FAILURE_LIST_RESEND = 'FAILURE_LIST_RESEND',
  /** #3 CustomerServiceService.reSend — CS 재발송 */
  CS_RESEND = 'CS_RESEND',
  /** #4 ExternalApiService.dispatchSend — 외부 API 주문 발급·발송 */
  EXTERNAL_API_SEND = 'EXTERNAL_API_SEND',
  /** #5 DeliveryBatchService.refundForFail — 배치 발송 실패 환불 */
  BATCH_REFUND_FOR_FAIL = 'BATCH_REFUND_FOR_FAIL',
  /** #6 ExternalApiService.phaseC_handleFailure — 외부 API 발송 실패 환불(EXTERNAL_FAIL) */
  EXTERNAL_API_FAIL_REFUND = 'EXTERNAL_API_FAIL_REFUND',
  /** #7 ExternalApiService.processCancelRefund — 외부 API 취소 환불(EXTERNAL_CANCEL) */
  EXTERNAL_API_CANCEL_REFUND = 'EXTERNAL_API_CANCEL_REFUND',
  /** #8 CustomerServiceService.restoreBalanceOnDiscard — CS 폐기 시 예치금·여신 복구(Tx2) */
  CS_DISCARD_RESTORE = 'CS_DISCARD_RESTORE',
  /** #9 SsgEventService.refundForDeliveryFail / refundResendEventDeduction — SSG 행사 잔액 복구 */
  SSG_EVENT_REFUND = 'SSG_EVENT_REFUND',
  /** #10 SsgRecoveryService sweep cron — ssg_balance_settled=false 잔류 건 재시도 */
  SSG_RECOVERY_SWEEP = 'SSG_RECOVERY_SWEEP',
  /** #12 RefundLedgerService.claim / claimWithManager — 현행 환불 멱등 게이트 */
  REFUND_LEDGER_CLAIM = 'REFUND_LEDGER_CLAIM',
}

/**
 * 전환 건이 legacy 진입점을 두드렸을 때의 거부 코드(§9 차단 방식).
 *
 * 플래그가 아니라 **데이터 사실**(`cutover_migrated_at`)로 판정하므로, 설정 플래그를 되돌려도
 * legacy 가 전환 건을 다시 처리하지 못한다(§9 롤백 규칙).
 */
export const DELIVERY_CUTOVER_LEGACY_BLOCKED = 'DELIVERY_CUTOVER_LEGACY_BLOCKED';

/**
 * 드레이닝(quiesce) 구간이라 **어느 모델로도 시작하지 않는다**는 거부 코드.
 *
 * 전환 마크를 세우기 전에 legacy 신규 진입만 먼저 막는 짧은 구간이며, 이때는 신규 모델도 시작하지
 * 않는다. 호출자는 재시도 가능한 일시 상태로 취급한다(cron 은 다음 사이클, 사용자 요청은 재시도 안내).
 */
export const DELIVERY_CUTOVER_DRAINING = 'DELIVERY_CUTOVER_DRAINING';

/**
 * 발송건의 컷오버 단계 (§9 quiesce 계약).
 *
 * `NONE → DRAINING → MIGRATED` 단방향이다. 드레이닝 확인과 전환 마크 설정 사이의 admission race
 * (가드를 통과한 legacy 워커가 그 직후 lease 를 잡는 창)를 닫으려면, 판정이 아니라 **진입 자체**를
 * 먼저 막고 잔여 작업이 빠져나갈 시간을 준 뒤에 전환해야 한다.
 */
export enum CutoverPhase {
  /** 미전환 — 기존 `claimedAt` 모델이 유일한 동시성 모델이다. */
  NONE = 'NONE',
  /** quiesce — legacy 신규 진입 금지, 신규 모델도 아직 미시작. 잔여 legacy 작업 배출 대기 구간. */
  DRAINING = 'DRAINING',
  /** 전환 완료 — Level A 슬롯 모델이 유일한 동시성 모델이다. */
  MIGRATED = 'MIGRATED',
}

/**
 * legacy claim CAS 에 **반드시 함께 실리는** 컷오버 배제 술어 (§9 quiesce 계약).
 *
 * 가드(`assertLegacyAllowed`)만으로는 admission race 가 남는다 — 가드가 `NONE` 을 읽은 워커가
 * 스케줄링·DB 대기로 지연되는 사이 운영자가 드레이닝·전환을 마칠 수 있고, 그 워커는 깨어나 legacy
 * claim 을 잡는다. 그 claim 은 잔여 확인 시점에 존재하지 않았으므로 10분 대기로도 잡히지 않는다.
 *
 * 그래서 **판정과 점유를 한 문장으로 원자화**한다. 이 술어를 claim CAS 의 `WHERE` 에 함께 넣으면
 * 마크 설정 이후의 claim 은 `affected=0` 으로 실패한다(= 늦게 깨어난 워커는 점유하지 못한다).
 * 가드는 "빠른 거부 + 원인 안내"용으로 남고, **안전성의 근거는 이 술어**다.
 *
 * @param deliveryIdExpr claim 대상 테이블의 `order_delivery.id` 에 해당하는 컬럼 식
 *                       (예: `order_delivery.id`, `order_delivery_refund.order_delivery_id`)
 */
export function notCutoverPredicate(deliveryIdExpr: string): string {
  return (
    `NOT EXISTS (SELECT 1 FROM delivery_workflow dw ` +
    `WHERE dw.order_delivery_id = ${deliveryIdExpr} ` +
    `AND (dw.cutover_draining_at IS NOT NULL OR dw.cutover_migrated_at IS NOT NULL))`
  );
}

/** `order_delivery` 를 직접 갱신하는 claim CAS 용 상수(가장 흔한 형태). */
export const NOT_CUTOVER_ORDER_DELIVERY = notCutoverPredicate('order_delivery.id');
