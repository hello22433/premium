import { createHash } from 'crypto';
import { CREDIT_EXCESS_SNAPSHOT_VERSION } from '../../entity/credit.excess.approval.entity';
import { OrderEntity } from '../../entity/order.entity';

/**
 * 신용초과 승인 스냅샷 (PII 최소화).
 *
 * - 서버가 주문/wallet 잠금 안에서 직접 계산한 값만 담는다 (클라이언트 입력 신뢰 금지).
 * - 수신 대상은 원문을 중복 저장하지 않고 delivery id + 지문(hash)만 저장한다.
 * - 발송확정 시 같은 잠금 범위에서 재계산해 항목별로 비교한다.
 */
export interface CreditExcessSnapshot {
  version: number;
  lifecycleMode: string;
  orderStatus: string;
  orderType: string;
  billingUserId: number;
  walletAccountId: string | null;
  settleMethod: string | null;
  cardSurchargeApplied: boolean;
  /** 최종 정산금액 (할인/할증 반영) */
  finalAmount: number;
  /** 잔여 한도 (LEGACY/SHADOW 신용초과 판정 기준) */
  remainServiceAmount: number;
  excessAmount: number;
  payableSettlementAmount: number;
  usage: {
    pointUseAmount: number;
    depositUseEnabled: boolean;
    depositUseAmount: number;
  };
  allocation: {
    pointUsedAmount: number;
    depositUsedAmount: number;
    creditUsedAmount: number;
    creditExcessAmount: number;
    cardSurchargeAmount: number;
  } | null;
  products: Array<{
    mappingId: number;
    productId: number;
    amount: number;
    price: number;
    fee: number | null;
    priceAdjustment: string | null;
    sendType: string | null;
  }>;
  deliveries: Array<{
    id: number;
    targetFingerprint: string;
    ssgEventId: number | null;
  }>;
}

export interface BuildSnapshotInput {
  order: OrderEntity;
  lifecycleMode: string;
  billingUserId: number;
  walletAccountId: string | null;
  settleMethod: string | null;
  cardSurchargeApplied: boolean;
  finalAmount: number;
  remainServiceAmount: number;
  excessAmount: number;
  payableSettlementAmount: number;
  usage: { pointUseAmount?: number; depositUseEnabled?: boolean; depositUseAmount?: number };
  allocation: CreditExcessSnapshot['allocation'];
}

/** 수신 대상 비교용 지문. 원문(암호문) 을 스냅샷에 중복 저장하지 않기 위한 단방향 값. */
export function fingerprintDeliveryTarget(target: string): string {
  return createHash('sha256').update(`credit-excess:${target}`).digest('hex').slice(0, 32);
}

export function buildCreditExcessSnapshot(input: BuildSnapshotInput): CreditExcessSnapshot {
  const products: CreditExcessSnapshot['products'] = [];
  const deliveries: CreditExcessSnapshot['deliveries'] = [];

  for (const mapping of input.order.orderProductMappings ?? []) {
    products.push({
      mappingId: mapping.id,
      productId: mapping.productId,
      amount: mapping.amount,
      price: mapping.product?.price ?? 0,
      fee: mapping.fee ?? null,
      priceAdjustment: (mapping.priceAdjustment as string | null) ?? null,
      sendType: (mapping.sendType as string | null) ?? null,
    });
    for (const delivery of mapping.orderDeliveries ?? []) {
      deliveries.push({
        id: delivery.id,
        targetFingerprint: fingerprintDeliveryTarget(delivery.deliveryTarget),
        ssgEventId: delivery.ssgEventId ?? null,
      });
    }
  }

  products.sort((a, b) => a.mappingId - b.mappingId);
  deliveries.sort((a, b) => a.id - b.id);

  return {
    version: CREDIT_EXCESS_SNAPSHOT_VERSION,
    lifecycleMode: input.lifecycleMode,
    orderStatus: input.order.status,
    orderType: input.order.type,
    billingUserId: input.billingUserId,
    walletAccountId: input.walletAccountId == null ? null : String(input.walletAccountId),
    settleMethod: input.settleMethod ?? null,
    cardSurchargeApplied: input.cardSurchargeApplied,
    finalAmount: input.finalAmount,
    remainServiceAmount: input.remainServiceAmount,
    excessAmount: input.excessAmount,
    payableSettlementAmount: input.payableSettlementAmount,
    usage: {
      pointUseAmount: input.usage.pointUseAmount ?? 0,
      depositUseEnabled: input.usage.depositUseEnabled ?? false,
      depositUseAmount: input.usage.depositUseAmount ?? 0,
    },
    allocation: input.allocation,
    products,
    deliveries,
  };
}

/**
 * 승인 시점 스냅샷과 발송확정 시점 재계산 스냅샷을 비교해 **변경된 항목명**만 반환한다.
 * 사용자 메시지에는 항목명만 노출하고 값(금액/수신처)은 노출하지 않는다.
 */
export function diffCreditExcessSnapshot(before: CreditExcessSnapshot, after: CreditExcessSnapshot): string[] {
  const changed: string[] = [];
  const mark = (label: string) => {
    if (!changed.includes(label)) changed.push(label);
  };

  if (before.version !== after.version) mark('승인 요청 양식');
  if (before.lifecycleMode !== after.lifecycleMode) mark('정산 처리 모드');
  if (before.orderStatus !== after.orderStatus) mark('주문 상태');
  if (before.orderType !== after.orderType) mark('주문 유형');
  if (before.billingUserId !== after.billingUserId) mark('과금 대상 계정');
  if (String(before.walletAccountId) !== String(after.walletAccountId)) mark('정산 계정');
  if (before.settleMethod !== after.settleMethod) mark('결제 수단');
  if (before.cardSurchargeApplied !== after.cardSurchargeApplied) mark('카드 할증');
  if (before.finalAmount !== after.finalAmount) mark('최종 정산 금액');
  if (before.payableSettlementAmount !== after.payableSettlementAmount) mark('결제 금액');
  if (before.excessAmount !== after.excessAmount) mark('신용초과 금액');
  if (before.remainServiceAmount !== after.remainServiceAmount) mark('잔여 한도');

  if (
    before.usage.pointUseAmount !== after.usage.pointUseAmount ||
    before.usage.depositUseEnabled !== after.usage.depositUseEnabled ||
    before.usage.depositUseAmount !== after.usage.depositUseAmount
  ) {
    mark('포인트/예치금 사용 입력');
  }

  const a = before.allocation;
  const b = after.allocation;
  if ((a == null) !== (b == null)) {
    mark('결제 배분');
  } else if (a && b) {
    if (
      a.pointUsedAmount !== b.pointUsedAmount ||
      a.depositUsedAmount !== b.depositUsedAmount ||
      a.creditUsedAmount !== b.creditUsedAmount ||
      a.creditExcessAmount !== b.creditExcessAmount ||
      a.cardSurchargeAmount !== b.cardSurchargeAmount
    ) {
      mark('결제 배분');
    }
  }

  if (JSON.stringify(before.products) !== JSON.stringify(after.products)) {
    mark('상품 구성/가격');
  }

  const beforeTargets = before.deliveries.map((d) => `${d.id}:${d.targetFingerprint}`).join(',');
  const afterTargets = after.deliveries.map((d) => `${d.id}:${d.targetFingerprint}`).join(',');
  if (beforeTargets !== afterTargets) mark('수신 대상');

  const beforeEvents = before.deliveries.map((d) => `${d.id}:${d.ssgEventId ?? '-'}`).join(',');
  const afterEvents = after.deliveries.map((d) => `${d.id}:${d.ssgEventId ?? '-'}`).join(',');
  if (beforeEvents !== afterEvents) mark('신세계 이벤트 연결');

  return changed;
}
