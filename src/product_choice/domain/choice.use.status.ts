import { IProductUseStatus } from '../../product/interface/product.status';

// 초이스쿠폰관리 탭의 등록상태 컬럼(정상/비정상) 판정.
// 구성상품이 하나라도 명시적 사용이 아니면 비정상이다.
// 미사용/영구미사용뿐 아니라 목록이 비었거나 상태가 없는(삭제/로딩 실패) 구성상품도 비정상으로 본다.
// fail-open을 막기 위해 모든 구성상품이 명시적으로 USE일 때만 정상으로 판정한다.
export const hasUnusedComponent = (componentUseStatuses: (IProductUseStatus | undefined | null)[]): boolean =>
  componentUseStatuses.length === 0 || componentUseStatuses.some((useStatus) => useStatus !== IProductUseStatus.USE);

// 초이스쿠폰의 useStatus는 구성상품 useStatus로부터 결정된다.
// 모든 구성상품이 명시적으로 사용일 때만 사용, 그 외(미사용/영구미사용/삭제/누락/빈 목록)는 미사용.
// 구성상품이 영구미사용이어도 초이스쿠폰은 UNUSED로 둔다. 구성상품을 교체하면 다시 사용할 수 있어야 하기 때문이다.
export const resolveChoiceUseStatus = (
  componentUseStatuses: (IProductUseStatus | undefined | null)[],
): IProductUseStatus => (hasUnusedComponent(componentUseStatuses) ? IProductUseStatus.UNUSED : IProductUseStatus.USE);
