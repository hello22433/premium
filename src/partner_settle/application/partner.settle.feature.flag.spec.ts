import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';
import { PartnerSettleFeatureFlag } from './partner.settle.feature.flag';

function build(env: Record<string, string | undefined>) {
  const configService = { get: jest.fn((key: string) => env[key]) };
  return new PartnerSettleFeatureFlag(configService as never);
}

describe('PartnerSettleFeatureFlag', () => {
  it('설정이 없으면 원장 producer 는 켜져 있다 (기본 활성)', () => {
    const flag = build({});

    expect(flag.isEnabled).toBe(true);
    // provider CSV 가 비어 있으므로 개별 provider 는 꺼진다.
    expect(flag.isEnabledFor(IPartnerCompanyType.GALAXIA)).toBe(false);
    expect(flag.hasAnyActiveProvider).toBe(false);
    expect(flag.isReviewResolutionEnabled).toBe(false);
  });

  it('전역 kill switch 가 off 면 provider 목록과 무관하게 전부 off 다', () => {
    const flag = build({
      PARTNER_SETTLE_LEDGER_ENABLED: 'false',
      PARTNER_SETTLE_LEDGER_PROVIDERS: 'GALAXIA,DAOU',
    });

    expect(flag.isEnabledFor(IPartnerCompanyType.GALAXIA)).toBe(false);
    expect(flag.hasAnyActiveProvider).toBe(false);
    expect(flag.isReviewResolutionEnabled).toBe(false);
  });

  it('kill switch 오타·대소문자는 fail-closed 로 처리한다', () => {
    expect(build({ PARTNER_SETTLE_LEDGER_ENABLED: 'FALSE' }).isEnabled).toBe(false);
    expect(build({ PARTNER_SETTLE_LEDGER_ENABLED: ' false ' }).isEnabled).toBe(false);
    expect(build({ PARTNER_SETTLE_LEDGER_ENABLED: ' True ' }).isEnabled).toBe(true);
    expect(build({ PARTNER_SETTLE_LEDGER_ENABLED: 'treu' }).isEnabled).toBe(false);
    expect(build({ PARTNER_SETTLE_LEDGER_ENABLED: '' }).isEnabled).toBe(false);
  });

  it('kill switch 만 켜고 provider 를 비워두면 아무것도 켜지지 않는다', () => {
    const flag = build({ PARTNER_SETTLE_LEDGER_ENABLED: 'true', PARTNER_SETTLE_LEDGER_PROVIDERS: '' });

    expect(flag.isEnabled).toBe(true);
    expect(flag.isEnabledFor(IPartnerCompanyType.GALAXIA)).toBe(false);
    expect(flag.isEnabledFor(IPartnerCompanyType.DAOU)).toBe(false);
    expect(flag.hasAnyActiveProvider).toBe(false);
  });

  it('CSV 에 있는 provider 만 켠다', () => {
    const flag = build({
      PARTNER_SETTLE_LEDGER_ENABLED: 'true',
      PARTNER_SETTLE_LEDGER_PROVIDERS: ' galaxia , DAOU ',
    });

    // 공백·대소문자는 운영 설정 실수의 단골이라 정규화한다.
    expect(flag.isEnabledFor(IPartnerCompanyType.GALAXIA)).toBe(true);
    expect(flag.isEnabledFor(IPartnerCompanyType.DAOU)).toBe(true);
    expect(flag.isEnabledFor(IPartnerCompanyType.GIFT_SHOW)).toBe(false);
  });

  it('전역 키 생략 + provider 만 설정하면 해당 provider 만 활성', () => {
    const flag = build({
      PARTNER_SETTLE_LEDGER_PROVIDERS: 'GALAXIA',
    });

    expect(flag.isEnabled).toBe(true);
    expect(flag.isEnabledFor(IPartnerCompanyType.GALAXIA)).toBe(true);
    expect(flag.isEnabledFor(IPartnerCompanyType.DAOU)).toBe(false);
    expect(flag.hasAnyActiveProvider).toBe(true);
  });

  it('provider 를 모르는 발송건은 켜지지 않는다', () => {
    const flag = build({
      PARTNER_SETTLE_LEDGER_ENABLED: 'true',
      PARTNER_SETTLE_LEDGER_PROVIDERS: 'GALAXIA',
    });

    expect(flag.isEnabledFor(null)).toBe(false);
    expect(flag.isEnabledFor(undefined)).toBe(false);
  });
  it('검토 해소 flag는 정확한 true일 때만 켜진다', () => {
    expect(build({ PARTNER_SETTLE_REVIEW_RESOLUTION_ENABLED: 'true' }).isReviewResolutionEnabled).toBe(true);
    expect(build({ PARTNER_SETTLE_REVIEW_RESOLUTION_ENABLED: 'TRUE' }).isReviewResolutionEnabled).toBe(false);
    expect(build({ PARTNER_SETTLE_REVIEW_RESOLUTION_ENABLED: 'tru' }).isReviewResolutionEnabled).toBe(false);
  });

  it('producer flag와 독립적으로 검토 해소 API를 제어한다', () => {
    const flag = build({
      PARTNER_SETTLE_LEDGER_ENABLED: 'true',
      PARTNER_SETTLE_LEDGER_PROVIDERS: 'GALAXIA',
    });

    expect(flag.isEnabledFor(IPartnerCompanyType.GALAXIA)).toBe(true);
    expect(flag.isReviewResolutionEnabled).toBe(false);
  });

  it('지원하지 않는 provider(GS_M_BIZ, PIN_INVENTORY, 오타)는 무시된다', () => {
    const flag = build({
      PARTNER_SETTLE_LEDGER_PROVIDERS: 'GALAXIA,GS_M_BIZ,PIN_INVENTORY,TYPO,galaxia',
    });

    expect(flag.getActiveProviders()).toEqual([IPartnerCompanyType.GALAXIA]);
    expect(flag.isEnabledFor(IPartnerCompanyType.GALAXIA)).toBe(true);
    expect(flag.isEnabledFor(IPartnerCompanyType.GS_M_BIZ)).toBe(false);
    expect(flag.isEnabledFor(IPartnerCompanyType.PIN_INVENTORY)).toBe(false);
    expect(flag.hasAnyActiveProvider).toBe(true);
  });

  it('지원 provider 만 있어도 중복은 제거된다', () => {
    const flag = build({
      PARTNER_SETTLE_LEDGER_PROVIDERS: 'GALAXIA,galaxia,GALAXIA',
    });

    expect(flag.getActiveProviders()).toEqual([IPartnerCompanyType.GALAXIA]);
  });

  it('CSV 가 미지원 provider 만이면 hasAnyActiveProvider=false', () => {
    const flag = build({
      PARTNER_SETTLE_LEDGER_PROVIDERS: 'GS_M_BIZ,PIN_INVENTORY,UNKNOWN',
    });

    expect(flag.isEnabled).toBe(true);
    expect(flag.hasAnyActiveProvider).toBe(false);
    expect(flag.getActiveProviders()).toEqual([]);
  });

  it('confirm flag 는 정확한 true 일 때만 켜진다', () => {
    expect(build({ PARTNER_SETTLE_CONFIRM_ENABLED: 'true' }).isConfirmEnabled).toBe(true);
    expect(build({ PARTNER_SETTLE_CONFIRM_ENABLED: 'false' }).isConfirmEnabled).toBe(false);
    expect(build({}).isConfirmEnabled).toBe(false);
  });

  it('paid flag 는 정확한 true 일 때만 켜진다', () => {
    expect(build({ PARTNER_SETTLE_PAID_ENABLED: 'true' }).isPaidEnabled).toBe(true);
    expect(build({ PARTNER_SETTLE_PAID_ENABLED: 'false' }).isPaidEnabled).toBe(false);
    expect(build({}).isPaidEnabled).toBe(false);
  });
});
