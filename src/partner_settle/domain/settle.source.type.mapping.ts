import { IProductSettleMethod } from '../../product/interface/product.settle.method';
import { IPartnerSettleSourceType } from '../interface/partner.settle.source.type';

/**
 * sourceType 결정 (정본 §6.1 · PR1B 명세 §4.2 D4).
 *
 * **producer 가 아니라 상품 `settleMethod` 가 결정한다.** 어떤 provider 훅에서 감지했는지는 무관하다.
 *
 * | settleMethod | 정산 사건 | sourceType |
 * |---|---|---|
 * | `PER_ISSUANCE` | 발송확정(발행) | ISSUANCE |
 * | `PER_EXCHANGE` | 교환/사용확인 | EXCHANGE |
 * | `PER_PRODUCT`  | 사용시각      | USAGE |
 *
 * 그래서 `PER_ISSUANCE` 상품의 사용·교환 관측은 **원장 사건이 아니다** — 한국문화진흥 사용조회로
 * 원장이나 `TIME_UNRECOVERABLE` 을 만들면 이미 발행 시점에 정산된 건을 두 번 세게 된다(§14 O5).
 */

/** producer 훅이 감지한 사건 종류. 정산성 판정 입력일 뿐 sourceType 이 아니다. */
export type ObservedEventKind = 'ISSUANCE' | 'EXCHANGE' | 'USAGE';

const SOURCE_TYPE_BY_SETTLE_METHOD: Readonly<Record<IProductSettleMethod, IPartnerSettleSourceType>> = {
  PER_ISSUANCE: 'ISSUANCE',
  PER_EXCHANGE: 'EXCHANGE',
  PER_PRODUCT: 'USAGE',
};

export function resolveSourceType(settleMethod: IProductSettleMethod): IPartnerSettleSourceType {
  return SOURCE_TYPE_BY_SETTLE_METHOD[settleMethod];
}

/**
 * 이 사건이 그 상품의 정산 사건인가.
 *
 * `settleMethod` 가 정한 사건 종류와 감지한 사건이 일치할 때만 원장을 만든다.
 */
export function isSettlementEvent(
  settleMethod: IProductSettleMethod | null | undefined,
  observed: ObservedEventKind,
): boolean {
  if (!settleMethod) return false;
  return SOURCE_TYPE_BY_SETTLE_METHOD[settleMethod] === observed;
}
