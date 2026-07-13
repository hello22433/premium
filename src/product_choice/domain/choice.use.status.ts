import { IProductUseStatus } from '../../product/interface/product.status';

// 초이스쿠폰관리 탭의 등록상태 컬럼(정상/비정상) 판정.
// 구성상품 중 미사용/영구미사용이 하나라도 있으면 비정상이다.
export const hasUnusedComponent = (componentUseStatuses: (IProductUseStatus | undefined | null)[]): boolean =>
  componentUseStatuses.some(
    (useStatus) => useStatus === IProductUseStatus.UNUSED || useStatus === IProductUseStatus.PERMANENTLY_UNUSED,
  );

// 초이스쿠폰의 useStatus는 구성상품 useStatus로부터 결정된다.
// 구성상품이 하나라도 사용 불가면 미사용, 전부 사용이면 사용.
// 구성상품이 영구미사용이어도 초이스쿠폰은 UNUSED로 둔다. 구성상품을 교체하면 다시 사용할 수 있어야 하기 때문이다.
export const resolveChoiceUseStatus = (
  componentUseStatuses: (IProductUseStatus | undefined | null)[],
): IProductUseStatus => (hasUnusedComponent(componentUseStatuses) ? IProductUseStatus.UNUSED : IProductUseStatus.USE);
