import { IProductUseStatus } from '../../product/interface/product.status';
import { ProductUseStatusAutoHistoryKey } from '../../product/domain/product.update.history.key.name';

// 사용상태 이력 한 건에서 자동/수동 판별에 필요한 부분만 본다.
export interface IUseStatusHistoryMark {
  key: string;
  afterValue: string | null;
}

// 초이스쿠폰이 "자동으로 미사용된 상태"인지 마지막 사용상태 이력으로 판별한다.
// 자동 key 이고 결과가 미사용이면 자동 강등이므로, 구성상품이 회복되면 자동으로 되돌린다.
// 관리자가 직접 내린 경우 마지막 이력의 key 는 'useStatus' 라 자동 복구 대상이 아니다.
// 이력이 없으면(자동 반영 도입 전 데이터) 수동으로 보고 복구하지 않는다.
// ProductService 의 자동 복구 판정과 ProductChoiceService 의 수동 확정 판정이 같은 규칙을 써야
// 두 경로의 정책이 어긋나지 않는다.
export const isAutoUnusedByHistory = (lastUseStatusHistory: IUseStatusHistoryMark | null | undefined): boolean =>
  lastUseStatusHistory?.key === ProductUseStatusAutoHistoryKey &&
  lastUseStatusHistory.afterValue !== IProductUseStatus.USE;

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
