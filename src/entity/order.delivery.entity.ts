import { Column, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { OrderProductMappingEntity } from './order.product.mapping.entity';
import { IOrderDeliveryStatus } from '../delivery/interface/order.delivery.status';
import { IOrderSendMethod } from '../order/interface/order.send.method';
import { SsgEventEntity } from './ssg.event.entity';
import { OrderDeliveryCouponStatus } from '../delivery/interface/order.delivery.coupon.status';
import { OrderDeliveryEmailCouponStatus } from '../delivery/interface/order.delivery.email.coupon.status';
import { ChoicePostSendStatus } from '../delivery/interface/choice.post.send.status';
import { ProductEntity } from './product.entity';
import { OrderHistoryEntity } from './order.history.entity';
import { OrderDeliveryRefundStatusEnum } from '../delivery/interface/order.delivery.refund.status.enum';
import { IPriceAdjustment } from '../user_discount/interface/price.adjustment';
import { IOrderSettleDiscountType } from '../order/interface/order.settle.discount.type';
import { IOrderDeliveryReportState } from '../delivery/interface/order.delivery.report.state';

@Entity('order_delivery')
export class OrderDeliveryEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ comment: '전송 상태' })
  status: IOrderDeliveryStatus;

  @Column({ comment: 'FK) order_product_mapping.id' })
  orderProductMappingId: number;

  @Column({ comment: '전달 방식 ex) EMAIL, SMS, ALIM_TALK' })
  deliveryMethod: IOrderSendMethod;

  @Column({ type: 'varchar', length: 128, comment: 'EMAIL 일 경우 email, SMS, ALIM_TALK 일 경우 핸드폰 번호' })
  deliveryTarget: string;

  @Column({ type: 'varchar', length: 128, nullable: true, comment: '최초 발송 수신정보 (암호화, CS 변경 시에도 불변)' })
  originalDeliveryTarget: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true, comment: '이미지 경로' })
  imagePath: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true, comment: '대치문자 1' })
  replaceCharacter1: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true, comment: '대치문자 2' })
  replaceCharacter2: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true, comment: '대치문자 3' })
  replaceCharacter3: string | null;

  @Column({ comment: '발송 요청 시각' })
  sendRequestAt: Date;

  @Column({ type: 'datetime', nullable: true, comment: '실제 발송 시각' })
  actualSendAt: Date | null;

  @Column({ type: 'datetime', nullable: true, comment: '만료 시간' })
  expireAt: Date | null;

  /**
   * 개인정보(PII) 파기 실행 시각. **실적 기록**이다 — 계산값이 아니다.
   *
   * 이 행의 PII 5종(deliveryTarget / originalDeliveryTarget / emailReceiverPhone /
   * bankAccount / bankAccountOwner)을 '-' 로 덮어쓴 시점을 기록한다. 기록 주체는 둘이다:
   *  · 정기파기 배치 — delivery.batch.service.ts 의 deliveryDeliveryTargetDestroy
   *  · 조기파기      — early.destroy.service.ts 의 executeRequest
   *
   * ⚠️ 왜 필요한가 — 이 컬럼이 없던 시절에는 "언제 파기했나"를 **계산으로 역추론**했다.
   *    `발송요청일 + 파기일수` 로 예정일을 구해 그것을 실적처럼 썼는데, 이 방식은 파기 규칙이
   *    바뀌는 순간 깨진다. 실제로 쿠폰 유효기간 가드가 들어오면서 규칙이
   *    `발송요청일 + 파기일수` → `MAX(발송요청일 + 파기일수, 유효기간 만료일 + 1일)` 로 바뀌었고,
   *    옛 규칙으로 이미 파기된 행에 새 규칙을 소급 적용하니 **이미 지운 건에 수년 뒤 미래 날짜**가
   *    나왔다. 파기확인서(대외 증빙)의 파기일 칸에 쓰이는 값이라 허위 증명이 된다.
   *    그래서 추론을 버리고 **파기 시점에 그냥 적는다**. 규칙이 또 바뀌어도 과거 기록은 안 흔들린다.
   *
   * NULL 의 뜻은 두 가지이고, deliveryTarget 으로 구분한다:
   *  · deliveryTarget != '-'  → 아직 파기되지 않았다(정상). 파기일은 예정일로 계산한다.
   *  · deliveryTarget == '-'  → **파기됐는데 시각을 모른다.** 컬럼 신설 시 백필에서 기준 컬럼
   *    (sendRequestAt / requestToDestroyPersonalInfoDay)이 결측이라 값을 못 채운 행이다.
   *    이때는 날짜를 지어내지 않고 null 로 응답한다(effective.destroy.date.ts 참조).
   *
   * 시각(시분초)까지 담지만 화면·확인서는 날짜만 쓴다. 초 단위를 남기는 이유는 감사 추적용이다.
   */
  @Column({ type: 'datetime', nullable: true, comment: '개인정보 파기 실행 시각' })
  destroyedAt: Date | null;

  /**
   * destroyedAt 의 **출처**. 그 값이 사실인지 추정인지를 판별하는 유일한 근거다.
   *
   * ⚠️ 왜 별도 컬럼이 필요한가 — destroyedAt 에는 성격이 다른 값이 섞인다:
   *      · 조기파기/정기파기가 각인한 값 → **사실**(그때 실제로 지웠다)
   *      · 컬럼 신설 백필 §3 이 계산한 값 → **추정**(옛 규칙으로 역산)
   *    그런데 날짜만 봐서는 어느 쪽인지 알 수 없다. 이 값이 파기확인서(대외 증빙)에 나가므로,
   *    "이 날짜가 실제 기록입니까"에 답할 수 없다는 것은 감당하기 어려운 모호함이다.
   *
   *    시각으로 추론하려던 시도는 실패했다. `TIME = '00:00:00'` 이면 추정이라는 프록시는
   *    양방향으로 틀린다 — 백필의 LEAST 가 NOW() 를 고른 추정 행은 자정이 아니고, 자정 크론
   *    (0 0 * * *)이 찍는 **진짜 실측**은 자정이다. 조기파기 요청과의 매칭도 그 축만 답할 뿐
   *    배치 실측과 백필 추정을 가르지 못한다. 그래서 값 자체에 출처를 적는다.
   *
   * 값:
   *  · EARLY             조기파기 실행 시 각인 (early.destroy.service)          — 사실
   *  · BATCH             정기파기 배치 실행 시 각인 (delivery.batch.service)     — 사실
   *  · BACKFILL_EARLY    컬럼 신설 백필 §2. early_destroy_request.executed_at 복사 — 사실
   *  · BACKFILL_ESTIMATE 컬럼 신설 백필 §3. `발송요청일 + 파기일수` 계산값        — **추정**
   *
   * 사실/추정 축으로는 BACKFILL_ESTIMATE 하나만 추정이다. 나머지 셋은 전부 실측이며,
   * BACKFILL_* 접두는 "코드 경로가 아니라 일회성 마이그레이션이 기록했다"는 뜻이다.
   *
   * NULL 은 destroyedAt 이 NULL 인 행(아직 파기 안 됨)과, 백필 이전에 각인됐는데 출처를
   * 모르는 행을 뜻한다. 후자는 정상 운영에서 나오지 않아야 한다.
   *
   * enum 이 아니라 varchar 인 이유: 값이 추가될 때 ALTER 를 다시 돌지 않기 위해서다.
   * (이 레포는 스키마를 수기 SQL 로 관리하므로 ALTER 한 번의 비용이 작지 않다.)
   */
  @Column({ type: 'varchar', length: 20, nullable: true, comment: '파기 시각의 출처 (사실/추정 판별)' })
  destroyedAtSource: string | null;

  @Column({ type: 'varchar', length: 256, nullable: true, comment: '트랜잭션 id' })
  transactionId: string | null;

  @Column({ type: 'varchar', length: 26, nullable: true, comment: '외부 API 트랜잭션 ID (ULID)' })
  externalTrId: string | null;

  @Column({ type: 'varchar', length: 256, nullable: true, comment: '전송 바코드' })
  barCode: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true, comment: '개인번호 for ssg' })
  personalCode: string | null;

  @Column({ type: 'int', nullable: true, comment: 'FK) ssg_event.id' })
  ssgEventId: number | null;

  @Column({ default: OrderDeliveryCouponStatus.NOT_USED })
  couponStatus: OrderDeliveryCouponStatus;

  @Column({ type: 'varchar', length: 100, nullable: true })
  emailCouponStatus: OrderDeliveryEmailCouponStatus | null;

  @Column({ type: 'varchar', length: 512, nullable: true, comment: '이메일 쿠폰 수령 시 입력한 핸드폰 번호 (암호화)' })
  emailReceiverPhone: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  ssgTransactionId: string | null;

  @Column({ type: 'int', nullable: true, comment: 'FK) product.id 초이스 쿠폰 시' })
  choiceSelectProductId: number | null;

  @Column({ type: 'datetime', nullable: true, comment: '실제 쿠폰 발급 일시 (초이스 선택/이메일 전화번호 입력 시점)' })
  couponIssuedAt: Date | null;

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '기타 외부 협력사 코드 정보' })
  couponNum: string | null;

  @Column({ type: 'datetime', nullable: true, comment: '교환시각' })
  tradeAt: Date | null;

  @Column({ type: 'varchar', length: 200, nullable: true, comment: '교환장소' })
  tradePlace: string | null;

  @Column({ default: 0, comment: '갤럭시아 상품권형 잔액' })
  galaxiaBalance: number;

  @Column({ type: 'datetime', nullable: true, comment: '독려 문자 일시' })
  encourageAt: Date | null;

  @Column({ type: 'datetime', nullable: true, comment: '재발송 완료 시각' })
  resendAt: Date | null;

  @Column({ type: 'int', default: 0, comment: '외부 API 재발송 누적 횟수' })
  resendCount: number;

  @Column({
    name: 'replaced_from_id',
    type: 'bigint',
    nullable: true,
    comment: '폐기 후 신규 발송 - 원본 OrderDelivery ID',
  })
  replacedFromId: number | null;

  @Column({ type: 'datetime', nullable: true, comment: '발송 실패 시각' })
  failedAt: Date | null;

  @Column({ type: 'datetime', precision: 6, nullable: true, comment: '발송 배치 중복 처리 방지용 클레임 시각' })
  claimedAt: Date | null;

  // 쿠폰상태 변형(폐기/외부취소/재발행) 진행중 lease. claimedAt(발송배치)과 반드시 별개 —
  // claimedAt 은 status 파티션별 stale 정책이 다르고(배치 WAIT=stale 없음), 부팅 sweep 이
  // WAIT+claimedAt 을 무조건 해제하므로 변형 lease 를 겸용하면 살아있는 점유가 강탈·삭제된다.
  @Column({
    type: 'datetime',
    precision: 6,
    nullable: true,
    comment: '쿠폰상태 변형(폐기/취소/재발행) 진행중 lease. 발송배치용 claimed_at 과 별개',
  })
  mutationClaimedAt: Date | null;

  @Column({ type: 'datetime', nullable: true, comment: '폐기/환불폐기 시각' })
  discardedAt: Date | null;

  @Column({ type: 'datetime', precision: 6, nullable: true, comment: '환불 발생 시각 (NULL=미환불)' })
  refundedAt: Date | null;

  @Column({ type: 'enum', enum: OrderDeliveryRefundStatusEnum, nullable: true, comment: '환불 상태' })
  refundStatus: OrderDeliveryRefundStatusEnum | null;

  @Column({ type: 'int', nullable: true, comment: '환불 률 1~100 으로 저장 및 사용' })
  refundRatio: number | null;

  @Column({ type: 'decimal', precision: 5, scale: 2, nullable: true, comment: '정산 수수료(%)' })
  settleFee: number | null;

  @Column({ type: 'varchar', length: 20, nullable: true, comment: '정산 할인/할증 구분' })
  settlePriceAdjustment: IPriceAdjustment | null;

  @Column({ type: 'varchar', length: 50, nullable: true, comment: '정산 할인 구분' })
  settleDiscountType: IOrderSettleDiscountType | null;

  @Column({ type: 'datetime', nullable: true, comment: '환불 접수 일자' })
  refundRegisterAt: Date | null;

  @Column({ type: 'varchar', nullable: true, comment: '은행명' })
  bankName: string | null;

  @Column({ type: 'varchar', nullable: true, comment: '계좌번호 (암호화 저장, CryptoCipher)' })
  bankAccount: string | null;

  @Column({ type: 'varchar', nullable: true, comment: '예금주' })
  bankAccountOwner: string | null;

  @Column({ type: 'datetime', nullable: true, comment: '환불일자' })
  refundAt: Date | null;

  @Column({ type: 'datetime', nullable: true, comment: '환불 승인 일자' })
  approveAt: Date | null;

  @Column({ name: 'api_error_code', type: 'varchar', length: 256, nullable: true, comment: '외부 api 응답 에러코드' })
  apiErrorCode: string | null;

  @Column({ type: 'varchar', length: 256, nullable: true, comment: '외부 api 응답 에러메시지' })
  apiErrorMessage: string | null;

  // ── 초이스 쿠폰 선택 후 별도 발송 상태 (재진입 차단용) ──
  @Column({
    type: 'varchar',
    length: 20,
    nullable: true,
    comment: '초이스 선택 후 별도 발송 상태 (NOT_REQUIRED/SENDING/SENT/FAILED). null=legacy',
  })
  choicePostSendStatus: ChoicePostSendStatus | null;

  @Column({
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '별도 발송 claim token (SENDING 소유권 판별용 UUID)',
  })
  choicePostSendClaimToken: string | null;

  @Column({ type: 'datetime', precision: 6, nullable: true, comment: '별도 발송 claim 획득 시각 (stale 판정용)' })
  choicePostSendClaimedAt: Date | null;

  @Column({ type: 'datetime', precision: 6, nullable: true, comment: '별도 쿠폰 이미지 발송 성공 시각' })
  choicePostSentAt: Date | null;

  // ── 초이스 선택 자체의 중복 실행 방지 claim ──
  @Column({
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '선택 claim token (최초 선택 CAS 소유권 판별용 UUID)',
  })
  choiceSelectionClaimToken: string | null;

  @Column({ type: 'datetime', precision: 6, nullable: true, comment: '선택 claim 획득 시각' })
  choiceSelectionClaimedAt: Date | null;

  @Column({ type: 'varchar', length: 64, nullable: true, comment: '공급사 멱등 발급/조회용 안정 attempt key' })
  choiceSelectionAttemptKey: string | null;

  @Column({
    type: 'datetime',
    precision: 6,
    nullable: true,
    comment: '선택 PIN 발급 결과 불명 → 운영 reconcile 필요 표시',
  })
  choiceSelectionReconcileRequiredAt: Date | null;

  // ── EMAIL 쿠폰 발송 동시성 claim ──
  @Column({ type: 'varchar', length: 64, nullable: true, comment: 'EMAIL 쿠폰 발송 claim token (UUID)' })
  emailCouponClaimToken: string | null;

  @Column({ type: 'datetime', precision: 6, nullable: true, comment: 'EMAIL 쿠폰 발송 claim 획득 시각' })
  emailCouponClaimedAt: Date | null;

  @Column({ type: 'varchar', length: 64, nullable: true, comment: 'EMAIL PIN 발급 멱등/조회용 안정 attempt key' })
  emailCouponAttemptKey: string | null;

  @Column({
    type: 'datetime',
    precision: 6,
    nullable: true,
    comment: 'EMAIL PIN 발급 결과 불명 → 운영 reconcile 필요 표시',
  })
  emailCouponReconcileRequiredAt: Date | null;

  // ── 알림톡 비동기 수신확인 / 자동 재발송 (ALIMTALK_ASYNC_REPORT) ──
  @Column({ type: 'varchar', length: 64, nullable: true, comment: '알림톡 msgKey (수신리포트 inquiry 키)' })
  alimTalkMsgKey: string | null;

  @Column({
    type: 'varchar',
    length: 20,
    nullable: true,
    comment: '수신리포트 확인 상태 (NULL=비대상/PENDING/CONFIRMED/UNCONFIRMED)',
  })
  reportState: IOrderDeliveryReportState | null;

  @Column({ type: 'datetime', nullable: true, comment: '리포트 확인 마감 시각 (미수신 영구대기 방지)' })
  reportDeadlineAt: Date | null;

  @Column({ type: 'int', default: 0, comment: '리포트 inquiry 누적 시도수' })
  reportAttemptCount: number;

  @Column({ type: 'int', default: 0, comment: 'SMS 폴백 자동 재발송 cap (resendCount 와 분리)' })
  reportFallbackAttemptCount: number;

  @Column({ type: 'datetime', nullable: true, comment: '다음 inquiry 수행 예정 시각 (30초 간격 근사)' })
  reportNextDueAt: Date | null;

  @Column({
    type: 'datetime',
    precision: 6,
    nullable: true,
    comment: 'reportSweep 멱등 claim 시각 (lease 만료 판정용)',
  })
  reportClaimedAt: Date | null;

  @Column({ type: 'varchar', length: 64, nullable: true, comment: 'reportSweep 회차 소유 토큰 (자기 토큰 행만 처리)' })
  reportOwnerToken: string | null;

  @ManyToOne(() => OrderProductMappingEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'order_product_mapping_id' })
  orderProductMapping: OrderProductMappingEntity;

  @ManyToOne(() => SsgEventEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'ssg_event_id' })
  ssgEvent?: SsgEventEntity;

  @ManyToOne(() => ProductEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'choice_select_product_id' })
  choiceSelectProduct?: ProductEntity;

  @OneToMany(() => OrderHistoryEntity, (history) => history.orderDelivery)
  orderHistory: OrderHistoryEntity[];
}
