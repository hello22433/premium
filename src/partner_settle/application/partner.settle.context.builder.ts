import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';
import { SettlementContext } from './partner.settle.producer.service';

/**
 * `OrderDeliveryEntity` (조인 필수: orderProductMapping.product.partnerCompany) → `SettlementContext`.
 *
 * 초이스쿠폰(`choiceSelectProductId`)은 선택된 상품의 협력사·expireDay 를 쓴다(§14 초이스).
 * **live `product` 조인 금지** — 스냅샷 필드(`snapshotProduct*`)만 쓴다.
 *
 * 조인이 로드되지 않은 엔티티가 들어오면 `null` 을 돌려준다(flag off 경로에서 조인 없이 부를 수 있다).
 */
export function buildSettlementContext(
  od: OrderDeliveryEntity,
  provider: IPartnerCompanyType,
): SettlementContext | null {
  const opm = od.orderProductMapping;
  if (!opm?.product) return null;

  const choiceProduct = od.choiceSelectProduct;
  const partnerCompanyId =
    choiceProduct?.partnerCompany?.id ?? opm.product.partnerCompany?.id ?? opm.product.partnerCompanyId;

  return {
    provider,
    partnerCompanyId,
    orderDeliveryId: od.id,
    settleMethod: opm.product.settleMethod ?? null,
    snapshot: {
      price: opm.snapshotProductPrice,
      category: opm.snapshotProductCategory,
      classificationId: opm.snapshotProductClassificationId,
      brandNameKorean: opm.snapshotProductBrandName,
    },
    subItem: {
      giftKind: null,
      brandCode: null,
      snapshotProductExpireDay: opm.snapshotProductExpireDay,
    },
  };
}
