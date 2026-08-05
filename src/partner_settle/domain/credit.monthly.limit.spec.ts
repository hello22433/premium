import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';
import {
  calculateMonthlyLimit,
  isSupportedCreditPartnerType,
  UnsupportedCreditPartnerTypeError,
} from './credit.monthly.limit';

describe('calculateMonthlyLimit (정본 §4.4)', () => {
  const amounts = { insuranceAmount: 100n, prepaidAmount: 200n, etcAmount: 30n };

  it.each([
    IPartnerCompanyType.SSG,
    IPartnerCompanyType.GIFT_SHOW,
    IPartnerCompanyType.GALAXIA,
    IPartnerCompanyType.CULTURELAND,
  ])('선입금+기타 타입(%s)은 보증보험을 제외한다', (type) => {
    expect(calculateMonthlyLimit(type, amounts)).toBe(230n);
  });

  it.each([IPartnerCompanyType.DAOU, IPartnerCompanyType.GIFTIEL])(
    '보증보험+선입금+기타 타입(%s)은 보증보험을 포함한다',
    (type) => {
      expect(calculateMonthlyLimit(type, amounts)).toBe(330n);
    },
  );

  it('여신 표 대상 밖 타입(GS_M_BIZ)은 fail-closed 한다', () => {
    expect(() => calculateMonthlyLimit(IPartnerCompanyType.GS_M_BIZ, amounts)).toThrow(
      UnsupportedCreditPartnerTypeError,
    );
  });

  it('2^53 을 넘는 금액도 BigInt 로 정확히 합산한다', () => {
    const big = {
      insuranceAmount: 9_007_199_254_740_993n, // 2^53 + 1
      prepaidAmount: 9_007_199_254_740_993n,
      etcAmount: 1n,
    };
    expect(calculateMonthlyLimit(IPartnerCompanyType.DAOU, big)).toBe(18_014_398_509_481_987n);
    expect(calculateMonthlyLimit(IPartnerCompanyType.SSG, big)).toBe(9_007_199_254_740_994n);
  });

  it('0 설정은 0 을 반환한다(정상 경로 · 미설정과 구분은 상위 서비스 책임)', () => {
    expect(
      calculateMonthlyLimit(IPartnerCompanyType.SSG, {
        insuranceAmount: 0n,
        prepaidAmount: 0n,
        etcAmount: 0n,
      }),
    ).toBe(0n);
  });
});

describe('isSupportedCreditPartnerType (PUT 사전 방어)', () => {
  it.each([
    IPartnerCompanyType.SSG,
    IPartnerCompanyType.GIFT_SHOW,
    IPartnerCompanyType.GALAXIA,
    IPartnerCompanyType.CULTURELAND,
    IPartnerCompanyType.DAOU,
    IPartnerCompanyType.GIFTIEL,
  ])('여신 표 6개 대상 타입(%s)은 true', (type) => {
    expect(isSupportedCreditPartnerType(type)).toBe(true);
  });

  it('비대상 타입(GS_M_BIZ)은 false — PUT 이 400 으로 거부해야 한다', () => {
    expect(isSupportedCreditPartnerType(IPartnerCompanyType.GS_M_BIZ)).toBe(false);
  });
});
