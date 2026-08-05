import { buildPolicyTargetKey, buildScopeKey, PartnerDiscountScopeFields } from './discount.scope.key';
import { IUserDiscountCategory } from '../../user_discount/interface/user.discount.category';
import { IUserDiscountMethod } from '../../user_discount/interface/user.discount.method';
import { ICompareCondition } from '../../user_discount/interface/compare.condition';

function scope(overrides: Partial<PartnerDiscountScopeFields> = {}): PartnerDiscountScopeFields {
  return {
    partnerCompanyId: 7,
    category: IUserDiscountCategory.PRODUCT_GROUP,
    classificationId: null,
    method: IUserDiscountMethod.BULK,
    primaryCategory: null,
    group: '모바일쿠폰',
    range: null,
    compareCondition: ICompareCondition.ALL,
    ...overrides,
  };
}

describe('buildScopeKey', () => {
  it('NULL 필드를 sentinel 로 채워 고정 길이 키를 만든다', () => {
    expect(buildScopeKey(scope())).toBe('sk1|7|PRODUCT_GROUP|-|BULK|-|모바일쿠폰|-|ALL');
  });

  it('같은 scope 는 항상 같은 키를 만든다', () => {
    expect(buildScopeKey(scope())).toBe(buildScopeKey(scope()));
  });

  it('구분자가 들어간 값이 인접 필드와 경계를 섞지 않는다', () => {
    // escape 가 없으면 group='a|b' 와 (group='a', primaryCategory='b') 가 같은 키가 된다.
    const withPipe = buildScopeKey(scope({ category: IUserDiscountCategory.PRODUCT_GROUP, group: 'a|b' }));
    const shifted = buildScopeKey(scope({ group: 'a', primaryCategory: 'b' }));

    expect(withPipe).not.toBe(shifted);
    expect(withPipe).toContain('a\\|b');
  });

  it('escape 문자 자체도 escape 한다', () => {
    expect(buildScopeKey(scope({ group: 'a\\b' }))).toContain('a\\\\b');
  });

  it('구간 표기의 앞뒤 공백과 유니코드 합성형 차이는 같은 scope 로 본다', () => {
    const padded = buildScopeKey(scope({ method: IUserDiscountMethod.SECTION, range: ' 10000 ' }));
    const plain = buildScopeKey(scope({ method: IUserDiscountMethod.SECTION, range: '10000' }));

    expect(padded).toBe(plain);
  });

  it('빈 문자열 구간은 미설정과 같게 본다', () => {
    const empty = buildScopeKey(scope({ method: IUserDiscountMethod.SECTION, range: '  ' }));
    const nullish = buildScopeKey(scope({ method: IUserDiscountMethod.SECTION, range: null }));

    expect(empty).toBe(nullish);
  });

  it('협력사가 다르면 다른 키다', () => {
    expect(buildScopeKey(scope({ partnerCompanyId: 7 }))).not.toBe(buildScopeKey(scope({ partnerCompanyId: 8 })));
  });
});

describe('buildPolicyTargetKey', () => {
  it('BULK 와 SECTION 이 같은 대상이면 같은 키다', () => {
    const bulk = buildPolicyTargetKey(scope({ method: IUserDiscountMethod.BULK }));
    const section = buildPolicyTargetKey(
      scope({ method: IUserDiscountMethod.SECTION, range: '10000', compareCondition: ICompareCondition.MORE }),
    );

    // 이 두 요청이 서로 다른 앵커를 잡으면 BULK/SECTION 상호배제 검증이 동시성에서 뚫린다.
    expect(bulk).toBe(section);
  });

  it('분류별로 그 분류가 쓰는 식별자만 키에 넣는다', () => {
    const brand = buildPolicyTargetKey(
      scope({ category: IUserDiscountCategory.BRAND, primaryCategory: '스타벅스', group: '무시됨' }),
    );
    const category = buildPolicyTargetKey(
      scope({ category: IUserDiscountCategory.CATEGORY, classificationId: 3, group: '무시됨' }),
    );

    expect(brand).toBe('pt1|7|BRAND|스타벅스');
    expect(category).toBe('pt1|7|CATEGORY|3');
  });

  it('scopeKey 와 네임스페이스가 갈린다', () => {
    expect(buildPolicyTargetKey(scope())).not.toBe(buildScopeKey(scope()));
  });
});
