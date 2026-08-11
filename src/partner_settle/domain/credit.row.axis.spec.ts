import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';
import { balanceSourceKind, CREDIT_ROW_AXIS, isUnsettledExempt } from './credit.row.axis';

describe('CREDIT_ROW_AXIS (정본 §4.1 표시 순서)', () => {
  it('표시 순서와 하위항목이 확정 계약과 일치한다', () => {
    const flat = CREDIT_ROW_AXIS.map((r) => `${r.partnerType}:${r.subItemKey}`);
    expect(flat).toEqual([
      'SSG:NONE',
      'GIFT_SHOW:NONE',
      'DAOU:NONE',
      'GIFTIEL:NONE',
      'GALAXIA:GALAXIA_MOBILE',
      'GALAXIA:GALAXIA_LOTTE',
      'GALAXIA:GALAXIA_HYUNDAI',
      'GALAXIA:GALAXIA_GALLERIA',
      'CULTURELAND:CULTURE_5Y',
      'CULTURELAND:CULTURE_60D',
    ]);
  });

  it('갤럭시아 롯데만 기본 숨김이다 (O10)', () => {
    const hidden = CREDIT_ROW_AXIS.filter((r) => r.hiddenByDefault).map((r) => r.subItemKey);
    expect(hidden).toEqual(['GALAXIA_LOTTE']);
  });
});

describe('balanceSourceKind (정본 §4.3)', () => {
  it.each([
    [IPartnerCompanyType.SSG, 'NONE', 'SSG_EVENT'],
    [IPartnerCompanyType.GIFT_SHOW, 'NONE', 'EXTERNAL_INQUIRY'],
    [IPartnerCompanyType.DAOU, 'NONE', 'LIMIT_MINUS_UNSETTLED'],
    [IPartnerCompanyType.GIFTIEL, 'NONE', 'LIMIT_MINUS_UNSETTLED'],
    [IPartnerCompanyType.CULTURELAND, 'CULTURE_5Y', 'LIMIT_MINUS_UNSETTLED'],
  ])('%s:%s → %s', (type, subItemKey, kind) => {
    expect(balanceSourceKind(type, subItemKey)).toBe(kind);
  });

  it('갤럭시아 쿠폰(MOBILE)은 여신, 백화점 3브랜드는 선충전이다', () => {
    expect(balanceSourceKind(IPartnerCompanyType.GALAXIA, 'GALAXIA_MOBILE')).toBe('LIMIT_MINUS_UNSETTLED');
    for (const dept of ['GALAXIA_LOTTE', 'GALAXIA_HYUNDAI', 'GALAXIA_GALLERIA']) {
      expect(balanceSourceKind(IPartnerCompanyType.GALAXIA, dept)).toBe('PREPAID_LEDGER');
    }
  });

  it('갤럭시아 미등록 하위항목은 선충전으로 추정하지 않고 fail-closed 한다', () => {
    expect(() => balanceSourceKind(IPartnerCompanyType.GALAXIA, 'GALAXIA_TYPO')).toThrow(
      '갤럭시아 여신 표 하위항목 미등록',
    );
  });

  it('SSG 만 미정산 정가 합계 예외다', () => {
    expect(isUnsettledExempt(IPartnerCompanyType.SSG)).toBe(true);
    expect(isUnsettledExempt(IPartnerCompanyType.DAOU)).toBe(false);
  });
});
