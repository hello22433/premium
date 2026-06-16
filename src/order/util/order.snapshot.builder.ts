import { UserEntity } from '../../entity/user.entity';
import { OrderEntity } from '../../entity/order.entity';
import { CompanyType } from '../../common/domain/company.type';
import { IUserSettleCondition } from '../../user/interface/user.settle.condition';
import { ProductEntity } from '../../entity/product.entity';
import { OrderProductMappingEntity } from '../../entity/order.product.mapping.entity';

// 주문 시점의 사용자/회사 정보를 OrderEntity 컬럼으로 매핑하는 헬퍼.
// 호출자는 user.company가 로드된 UserEntity를 넘겨야 한다 (relations: ['company']).

type OrderUserSnapshotPart = Pick<
  OrderEntity,
  | 'snapshotPersonName'
  | 'snapshotPersonPhone'
  | 'snapshotEmail'
  | 'snapshotBusinessName'
  | 'snapshotBusinessNumber'
  | 'snapshotBusinessAddress'
  | 'snapshotIndustryType'
  | 'snapshotIndustryItem'
  | 'snapshotSettleCondition'
  | 'snapshotDocumentCompanyType'
>;

type OrderClientUserSnapshotPart = Pick<
  OrderEntity,
  | 'snapshotClientPersonName'
  | 'snapshotClientPersonPhone'
  | 'snapshotClientEmail'
  | 'snapshotClientBusinessName'
  | 'snapshotClientBusinessNumber'
  | 'snapshotClientBusinessAddress'
  | 'snapshotClientIndustryType'
  | 'snapshotClientIndustryItem'
  | 'snapshotClientSettleCondition'
  | 'snapshotClientDocumentCompanyType'
>;

export function buildOrderUserSnapshot(user: UserEntity): OrderUserSnapshotPart {
  return {
    snapshotPersonName: user.personName,
    snapshotPersonPhone: user.personPhoneNumber,
    snapshotEmail: user.email,
    snapshotBusinessName: user.company?.businessName ?? null,
    snapshotBusinessNumber: user.company?.businessNumber ?? null,
    snapshotBusinessAddress: user.company?.businessAddress ?? null,
    snapshotIndustryType: user.company?.industryType ?? null,
    snapshotIndustryItem: user.company?.industryItem ?? null,
    snapshotSettleCondition: user.settleCondition,
    snapshotDocumentCompanyType: user.documentCompanyType,
  };
}

export function buildOrderClientUserSnapshot(clientUser: UserEntity | null): OrderClientUserSnapshotPart {
  if (!clientUser) {
    return {
      snapshotClientPersonName: null,
      snapshotClientPersonPhone: null,
      snapshotClientEmail: null,
      snapshotClientBusinessName: null,
      snapshotClientBusinessNumber: null,
      snapshotClientBusinessAddress: null,
      snapshotClientIndustryType: null,
      snapshotClientIndustryItem: null,
      snapshotClientSettleCondition: null,
      snapshotClientDocumentCompanyType: null,
    };
  }
  return {
    snapshotClientPersonName: clientUser.personName,
    snapshotClientPersonPhone: clientUser.personPhoneNumber,
    snapshotClientEmail: clientUser.email,
    snapshotClientBusinessName: clientUser.company?.businessName ?? null,
    snapshotClientBusinessNumber: clientUser.company?.businessNumber ?? null,
    snapshotClientBusinessAddress: clientUser.company?.businessAddress ?? null,
    snapshotClientIndustryType: clientUser.company?.industryType ?? null,
    snapshotClientIndustryItem: clientUser.company?.industryItem ?? null,
    snapshotClientSettleCondition: clientUser.settleCondition,
    snapshotClientDocumentCompanyType: clientUser.documentCompanyType,
  };
}

export function buildOrderOperationUserSnapshot(
  operationUser: UserEntity | null,
): Pick<OrderEntity, 'snapshotOperationPersonName'> {
  return { snapshotOperationPersonName: operationUser?.personName ?? null };
}

// ────────────────────────────────────────────────────────────
// Reader: 조회 시 스냅샷 우선, NULL이면 user FK join 결과로 fallback.
// 마이그레이션 도입 이전 주문은 스냅샷이 비어있을 수 있어 fallback 경로가 필요하다.
// ────────────────────────────────────────────────────────────

export type OrderUserView = {
  personName: string;
  personPhoneNumber: string | null;
  email: string | null;
  businessName: string;
  businessNumber: string;
  businessAddress: string | null;
  industryType: string | null;
  industryItem: string | null;
  settleCondition: IUserSettleCondition;
  documentCompanyType: CompanyType;
};

export function readUserView(order: OrderEntity): OrderUserView {
  const fk = order.user;
  return {
    personName: order.snapshotPersonName ?? fk?.personName ?? '',
    personPhoneNumber: order.snapshotPersonPhone ?? fk?.personPhoneNumber ?? null,
    email: order.snapshotEmail ?? fk?.email ?? null,
    businessName: order.snapshotBusinessName ?? fk?.company?.businessName ?? '',
    businessNumber: order.snapshotBusinessNumber ?? fk?.company?.businessNumber ?? '',
    businessAddress: order.snapshotBusinessAddress ?? fk?.company?.businessAddress ?? null,
    industryType: order.snapshotIndustryType ?? fk?.company?.industryType ?? null,
    industryItem: order.snapshotIndustryItem ?? fk?.company?.industryItem ?? null,
    settleCondition: order.snapshotSettleCondition ?? fk!.settleCondition,
    documentCompanyType: order.snapshotDocumentCompanyType ?? fk?.documentCompanyType ?? CompanyType.ENMAD,
  };
}

export function readClientUserView(order: OrderEntity): OrderUserView | null {
  if (order.clientUserId == null) return null;
  const fk = order.clientUser;
  return {
    personName: order.snapshotClientPersonName ?? fk?.personName ?? '',
    personPhoneNumber: order.snapshotClientPersonPhone ?? fk?.personPhoneNumber ?? null,
    email: order.snapshotClientEmail ?? fk?.email ?? null,
    businessName: order.snapshotClientBusinessName ?? fk?.company?.businessName ?? '',
    businessNumber: order.snapshotClientBusinessNumber ?? fk?.company?.businessNumber ?? '',
    businessAddress: order.snapshotClientBusinessAddress ?? fk?.company?.businessAddress ?? null,
    industryType: order.snapshotClientIndustryType ?? fk?.company?.industryType ?? null,
    industryItem: order.snapshotClientIndustryItem ?? fk?.company?.industryItem ?? null,
    settleCondition: order.snapshotClientSettleCondition ?? fk!.settleCondition,
    documentCompanyType: order.snapshotClientDocumentCompanyType ?? fk?.documentCompanyType ?? CompanyType.ENMAD,
  };
}

// 거래명세서/정산: 대행주문이면 clientUser, 아니면 user 정보 (clientUser ?? user 패턴)
export function readBillingView(order: OrderEntity): OrderUserView {
  return readClientUserView(order) ?? readUserView(order);
}

export function readOperationPersonName(order: OrderEntity): string | null {
  return order.snapshotOperationPersonName ?? order.operationUser?.personName ?? null;
}

// ────────────────────────────────────────────────────────────
// 라인(OrderProductMapping) 상품 스냅샷 builder / reader
// ────────────────────────────────────────────────────────────

export type LineProductSnapshotPart = Pick<
  OrderProductMappingEntity,
  'snapshotProductPrice' | 'snapshotProductName' | 'snapshotProductBrandName'
  | 'snapshotProductExpireDay' | 'snapshotProductImagePath'
>;

// 주문 시점 상품 정보 박제. product.brand가 로드된 ProductEntity를 넘겨야 함.
export function buildLineProductSnapshot(product: ProductEntity): LineProductSnapshotPart {
  return {
    snapshotProductPrice: product.price ?? null,
    snapshotProductName: product.name ?? null,
    snapshotProductBrandName: product.brand?.nameKorean ?? '',
    snapshotProductExpireDay: product.expireDay ?? null,
    snapshotProductImagePath: product.imagePath ?? null,
  };
}

export type LineProductView = {
  name: string;
  price: number;
  brandName: string;
  expireDay: number;
  imagePath: string | null;
};

// 조회 시 snapshot 우선, NULL이면 LIVE product fallback (readBillingView와 동일 패턴).
export function readLineProductView(opm: OrderProductMappingEntity): LineProductView {
  return {
    name: opm.snapshotProductName ?? opm.product?.name ?? '(삭제된 상품)',
    price: opm.snapshotProductPrice ?? opm.product?.price ?? 0,
    brandName: opm.snapshotProductBrandName ?? opm.product?.brand?.nameKorean ?? '',
    expireDay: opm.snapshotProductExpireDay ?? opm.product?.expireDay ?? 0,
    imagePath: opm.snapshotProductImagePath ?? opm.product?.imagePath ?? null,
  };
}

export type PriceDivergence = {
  priceChanged: boolean;
  snapshotPrice: number | null;
  currentPrice: number | null;
};

// 주문 시점 스냅샷 가격과 현재 상품 가격의 차이를 감지한다.
// snapshotPrice가 null(legacy)이거나 currentPrice가 null(삭제 상품)이면 priceChanged=false.
export function buildPriceDivergence(opm: OrderProductMappingEntity): PriceDivergence {
  const snapshotPrice = opm.snapshotProductPrice;
  const currentPrice = opm.product?.price ?? null;
  const priceChanged = snapshotPrice != null && currentPrice != null && snapshotPrice !== currentPrice;
  return { priceChanged, snapshotPrice, currentPrice };
}
