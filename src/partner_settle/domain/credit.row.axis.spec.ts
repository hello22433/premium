import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';
import {
  balanceSourceKind,
  CREDIT_ROW_AXIS,
  isUnsettledExempt,
} from './credit.row.axis';

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
    [IPartnerCompanyType.SSG, 'SSG_EVENT'],
    [IPartnerCompanyType.GIFT_SHOW, 'EXTERNAL_INQUIRY'],
    [IPartnerCompanyType.GALAXIA, 'EXTERNAL_INQUIRY'],
    [IPartnerCompanyType.DAOU, 'LIMIT_MINUS_UNSETTLED'],
    [IPartnerCompanyType.GIFTIEL, 'LIMIT_MINUS_UNSETTLED'],
    [IPartnerCompanyType.CULTURELAND, 'LIMIT_MINUS_UNSETTLED'],
  ])('%s → %s', (type, kind) => {
    expect(balanceSourceKind(type)).toBe(kind);
  });

  it('SSG 만 미정산 정가 합계 예외다', () => {
    expect(isUnsettledExempt(IPartnerCompanyType.SSG)).toBe(true);
    expect(isUnsettledExempt(IPartnerCompanyType.DAOU)).toBe(false);
  });
});
