import { WalletResourceType } from './wallet-resource-type';

/**
 * deliveryId 가 없는(주문 단위) idempotency key 의 sentinel.
 *
 * `confirm_release:{orderId}::point:42` 같이 빈 문자열을 segment 로 두면 split 시 모호하므로
 * sentinel 문자열 `'ORDER'` 로 명시한다 (plan v2.1 F-003 결정).
 */
export const ORDER_LEVEL_SENTINEL = 'ORDER' as const;

/**
 * Resource 문자열 변환. POINT 는 `point:{pointGrantId}` 형식 (plan §1 row split + §2 catalog).
 * 다른 resource 는 enum 이름 lowercase.
 */
export function formatResource(resource: WalletResourceType, pointGrantId?: number | null): string {
  if (resource === WalletResourceType.POINT) {
    if (pointGrantId == null) {
      throw new Error('POINT resource 는 pointGrantId 필수');
    }
    return `point:${pointGrantId}`;
  }
  if (resource === WalletResourceType.DEPOSIT) return 'deposit';
  if (resource === WalletResourceType.CREDIT) return 'credit';
  if (resource === WalletResourceType.CREDIT_EXCESS) return 'credit_excess';
  throw new Error(`Unknown WalletResourceType: ${String(resource)}`);
}

function deliverySegment(deliveryId: number | null | undefined): string {
  return deliveryId == null ? '' : String(deliveryId);
}

function orderLevelDeliverySegment(deliveryId: number | null | undefined): string {
  // confirm_release 는 주문 단위 보상 가능 → null/undefined 시 sentinel 사용
  return deliveryId == null ? ORDER_LEVEL_SENTINEL : String(deliveryId);
}

/** plan §2 single-shot: confirm:{orderId}:{deliveryId}:{resource} */
export function buildConfirmKey(orderId: number, deliveryId: number, resource: WalletResourceType, pointGrantId?: number | null): string {
  return `confirm:${orderId}:${deliveryId}:${formatResource(resource, pointGrantId)}`;
}

/** plan §2 single-shot + v2.1 sentinel: confirm_release:{orderId}:{deliveryId|ORDER}:{resource} */
export function buildConfirmReleaseKey(
  orderId: number,
  deliveryId: number | null,
  resource: WalletResourceType,
  pointGrantId?: number | null,
): string {
  return `confirm_release:${orderId}:${orderLevelDeliverySegment(deliveryId)}:${formatResource(resource, pointGrantId)}`;
}

/** plan §2 repeatable: fail_refund:{orderId}:{deliveryId}:{resource}:{attemptId} */
export function buildFailRefundKey(
  orderId: number,
  deliveryId: number,
  resource: WalletResourceType,
  attemptId: number,
  pointGrantId?: number | null,
): string {
  return `fail_refund:${orderId}:${deliveryId}:${formatResource(resource, pointGrantId)}:${attemptId}`;
}

/** plan §2 repeatable: discard_refund:{orderId}:{deliveryId}:{resource}:{attemptId} */
export function buildDiscardRefundKey(
  orderId: number,
  deliveryId: number,
  resource: WalletResourceType,
  attemptId: number,
  pointGrantId?: number | null,
): string {
  return `discard_refund:${orderId}:${deliveryId}:${formatResource(resource, pointGrantId)}:${attemptId}`;
}

/** plan §2 repeatable: discard_undo:{orderId}:{deliveryId}:{resource}:{attemptId} */
export function buildDiscardUndoKey(
  orderId: number,
  deliveryId: number,
  resource: WalletResourceType,
  attemptId: number,
  pointGrantId?: number | null,
): string {
  return `discard_undo:${orderId}:${deliveryId}:${formatResource(resource, pointGrantId)}:${attemptId}`;
}

/**
 * plan §2 repeatable + v2.1 inline cycle: settle_release:{orderId}::{resource}:{cycleId}
 * cycleId 형식 = `${orderId}_${seq}` (PR3-001 결정, wallet_account FOR UPDATE 컨텍스트 race-free).
 */
export function buildSettleReleaseKey(
  orderId: number,
  cycleId: string,
  resource: WalletResourceType,
  pointGrantId?: number | null,
): string {
  return `settle_release:${orderId}::${formatResource(resource, pointGrantId)}:${cycleId}`;
}

/** plan §2 repeatable: settle_undo:{orderId}::{resource}:{cycleId} (동일 cycleId = release 와 매칭) */
export function buildSettleUndoKey(
  orderId: number,
  cycleId: string,
  resource: WalletResourceType,
  pointGrantId?: number | null,
): string {
  return `settle_undo:${orderId}::${formatResource(resource, pointGrantId)}:${cycleId}`;
}

/** plan §2 repeatable: resend_deduct:{orderId}:{deliveryId}:{resource}:{attemptId} */
export function buildResendDeductKey(
  orderId: number,
  deliveryId: number,
  resource: WalletResourceType,
  attemptId: number,
  pointGrantId?: number | null,
): string {
  return `resend_deduct:${orderId}:${deliveryId}:${formatResource(resource, pointGrantId)}:${attemptId}`;
}

/** plan §2 repeatable: resend_undo:{orderId}:{deliveryId}:{resource}:{attemptId} */
export function buildResendUndoKey(
  orderId: number,
  deliveryId: number,
  resource: WalletResourceType,
  attemptId: number,
  pointGrantId?: number | null,
): string {
  return `resend_undo:${orderId}:${deliveryId}:${formatResource(resource, pointGrantId)}:${attemptId}`;
}
