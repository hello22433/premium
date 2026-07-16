import { IProductUseStatus } from '../../product/interface/product.status';
import { hasUnusedComponent, resolveChoiceUseStatus } from './choice.use.status';

describe('hasUnusedComponent', () => {
  it('구성상품이 모두 사용이면 false', () => {
    expect(hasUnusedComponent([IProductUseStatus.USE, IProductUseStatus.USE])).toBe(false);
  });

  it('미사용 구성상품이 하나라도 있으면 true', () => {
    expect(hasUnusedComponent([IProductUseStatus.USE, IProductUseStatus.UNUSED])).toBe(true);
  });

  it('영구미사용 구성상품이 하나라도 있으면 true', () => {
    expect(hasUnusedComponent([IProductUseStatus.USE, IProductUseStatus.PERMANENTLY_UNUSED])).toBe(true);
  });

  it('구성상품이 없으면 true (사용 가능한 구성상품이 없으므로 비정상)', () => {
    expect(hasUnusedComponent([])).toBe(true);
  });

  it('관계 로딩 실패/구성상품 삭제 등으로 상태가 없는 구성상품이 있으면 비정상으로 본다', () => {
    expect(hasUnusedComponent([IProductUseStatus.USE, undefined])).toBe(true);
    expect(hasUnusedComponent([IProductUseStatus.USE, null])).toBe(true);
  });
});

describe('resolveChoiceUseStatus', () => {
  it('구성상품이 모두 사용이면 초이스쿠폰도 사용', () => {
    expect(resolveChoiceUseStatus([IProductUseStatus.USE, IProductUseStatus.USE])).toBe(IProductUseStatus.USE);
  });

  it('미사용 구성상품이 있으면 초이스쿠폰은 미사용', () => {
    expect(resolveChoiceUseStatus([IProductUseStatus.USE, IProductUseStatus.UNUSED])).toBe(IProductUseStatus.UNUSED);
  });

  it('영구미사용 구성상품이 있어도 초이스쿠폰은 미사용이지 영구미사용이 아니다', () => {
    expect(resolveChoiceUseStatus([IProductUseStatus.PERMANENTLY_UNUSED])).toBe(IProductUseStatus.UNUSED);
  });

  it('미사용이었다가 구성상품이 모두 복구되면 다시 사용으로 계산된다', () => {
    expect(resolveChoiceUseStatus([IProductUseStatus.UNUSED, IProductUseStatus.USE])).toBe(IProductUseStatus.UNUSED);
    expect(resolveChoiceUseStatus([IProductUseStatus.USE, IProductUseStatus.USE])).toBe(IProductUseStatus.USE);
  });

  it('구성상품이 하나도 없으면 미사용 (사용 가능한 구성상품이 없으므로)', () => {
    expect(resolveChoiceUseStatus([])).toBe(IProductUseStatus.UNUSED);
  });

  it('상태가 없는 구성상품이 섞여 있으면 나머지가 모두 사용이어도 미사용', () => {
    expect(resolveChoiceUseStatus([IProductUseStatus.USE, undefined])).toBe(IProductUseStatus.UNUSED);
    expect(resolveChoiceUseStatus([IProductUseStatus.USE, null])).toBe(IProductUseStatus.UNUSED);
  });
});
