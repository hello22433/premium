import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';
import { PartnerSettleFeatureFlag } from './partner.settle.feature.flag';

function build(env: Record<string, string | undefined>) {
  const configService = { get: jest.fn((key: string) => env[key]) };
  return new PartnerSettleFeatureFlag(configService as never);
}

describe('PartnerSettleFeatureFlag', () => {
  it('설정이 없으면 꺼져 있다', () => {
    const flag = build({});

    // 배포 기본값은 전부 off 다. 기본값이 on 이면 배포 즉시 원장이 쌓인다.
    expect(flag.isEnabled).toBe(false);
    expect(flag.isEnabledFor(IPartnerCompanyType.GALAXIA)).toBe(false);
  });

  it('전역 kill switch 가 off 면 provider 목록과 무관하게 전부 off 다', () => {
    const flag = build({
      PARTNER_SETTLE_LEDGER_ENABLED: 'false',
      PARTNER_SETTLE_LEDGER_PROVIDERS: 'GALAXIA,DAOU',
    });

    expect(flag.isEnabledFor(IPartnerCompanyType.GALAXIA)).toBe(false);
  });

  it('kill switch 만 켜고 provider 를 비워두면 아무것도 켜지지 않는다', () => {
    const flag = build({ PARTNER_SETTLE_LEDGER_ENABLED: 'true', PARTNER_SETTLE_LEDGER_PROVIDERS: '' });

    // 빈 값을 "전체 허용" 으로 읽으면 kill switch 를 켜는 순간 6개 provider 가 한꺼번에 원장을 쓴다.
    expect(flag.isEnabled).toBe(true);
    expect(flag.isEnabledFor(IPartnerCompanyType.GALAXIA)).toBe(false);
    expect(flag.isEnabledFor(IPartnerCompanyType.DAOU)).toBe(false);
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

  it('provider 를 모르는 발송건은 켜지지 않는다', () => {
    const flag = build({
      PARTNER_SETTLE_LEDGER_ENABLED: 'true',
      PARTNER_SETTLE_LEDGER_PROVIDERS: 'GALAXIA',
    });

    expect(flag.isEnabledFor(null)).toBe(false);
    expect(flag.isEnabledFor(undefined)).toBe(false);
  });
});
