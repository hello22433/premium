import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';
import { buildCreditRow, BuildCreditRowInput } from './credit.list.assembly';
import { CreditRowSpec } from './credit.row.axis';

function spec(partnerType: IPartnerCompanyType, subItemKey: string, hiddenByDefault = false): CreditRowSpec {
  return { partnerType, subItemKey, hiddenByDefault };
}

function input(over: Partial<BuildCreditRowInput> = {}): BuildCreditRowInput {
  return {
    spec: spec(IPartnerCompanyType.DAOU, 'NONE'),
    partnerCompanyId: 10,
    partnerName: '다우기술',
    monthlyLimit: 1000n,
    agg: { unsettled: 300n, prevMonth: 500n, reviewCount: 0, reviewBase: 0n },
    orphanCount: 0,
    balance: { balance: 700n, status: 'AVAILABLE' },
    ...over,
  };
}

describe('buildCreditRow (정본 §4.2·§4.3·§9)', () => {
  it('정상 행: 금액 문자열·OK·발송가능잔액 노출', () => {
    const row = buildCreditRow(input());
    expect(row).toMatchObject({
      partnerCompanyId: 10,
      subItemKey: 'NONE',
      monthlyLimit: '1000',
      unsettledBaseAmount: '300',
      previousMonthBaseAmount: '500',
      availableBalance: '700',
      balanceSourceStatus: 'AVAILABLE',
      creditDataStatus: 'OK',
      reviewCount: 0,
      orphanPendingCount: 0,
      hidden: false,
    });
  });

  it('SSG 는 미정산 정가 합계를 노출하지 않는다(null)', () => {
    const row = buildCreditRow(
      input({
        spec: spec(IPartnerCompanyType.SSG, 'NONE'),
        balance: { balance: 5000n, status: 'AVAILABLE' },
      }),
    );
    expect(row.unsettledBaseAmount).toBeNull();
    expect(row.availableBalance).toBe('5000');
  });

  it('NEEDS_REVIEW 미해소 → fail-closed(availableBalance null · reviewCount 노출)', () => {
    const row = buildCreditRow(
      input({ agg: { unsettled: 300n, prevMonth: 500n, reviewCount: 2, reviewBase: 12345n } }),
    );
    expect(row.creditDataStatus).toBe('NEEDS_REVIEW');
    expect(row.availableBalance).toBeNull();
    expect(row.reviewCount).toBe(2);
    expect(row.reviewBaseAmount).toBe('12345');
  });

  it('orphan 미원장 → fail-closed(availableBalance null · orphanPendingCount)', () => {
    const row = buildCreditRow(input({ orphanCount: 3 }));
    expect(row.creditDataStatus).toBe('NEEDS_REVIEW');
    expect(row.availableBalance).toBeNull();
    expect(row.orphanPendingCount).toBe(3);
  });

  it('외부 잔액조회가 AVAILABLE 이어도 fail-closed 면 차단 우선(33차-7.3)', () => {
    const row = buildCreditRow(
      input({
        spec: spec(IPartnerCompanyType.GALAXIA, 'GALAXIA_MOBILE'),
        balance: { balance: 9999n, status: 'AVAILABLE' },
        orphanCount: 1,
      }),
    );
    expect(row.availableBalance).toBeNull();
    expect(row.balanceSourceStatus).toBe('AVAILABLE'); // 원 조회 상태는 보존
    expect(row.creditDataStatus).toBe('NEEDS_REVIEW');
  });

  it('미연동(NOT_AVAILABLE) 잔액은 그대로 null·상태 전달', () => {
    const row = buildCreditRow(
      input({
        spec: spec(IPartnerCompanyType.GIFT_SHOW, 'NONE'),
        balance: { balance: null, status: 'NOT_AVAILABLE' },
      }),
    );
    expect(row.availableBalance).toBeNull();
    expect(row.balanceSourceStatus).toBe('NOT_AVAILABLE');
    expect(row.creditDataStatus).toBe('OK');
  });

  describe('갤럭시아 롯데 숨김 (O10)', () => {
    const lotte = spec(IPartnerCompanyType.GALAXIA, 'GALAXIA_LOTTE', true);

    it('미정산 0 · 전월 0 → 숨김', () => {
      const row = buildCreditRow(
        input({
          spec: lotte,
          agg: { unsettled: 0n, prevMonth: 0n, reviewCount: 0, reviewBase: 0n },
          balance: { balance: null, status: 'NOT_AVAILABLE' },
        }),
      );
      expect(row.hidden).toBe(true);
    });

    it('미정산 ≠ 0 → 자동 재표시', () => {
      const row = buildCreditRow(
        input({
          spec: lotte,
          agg: { unsettled: 1n, prevMonth: 0n, reviewCount: 0, reviewBase: 0n },
          balance: { balance: null, status: 'NOT_AVAILABLE' },
        }),
      );
      expect(row.hidden).toBe(false);
    });

    it('전월 ≠ 0 → 자동 재표시', () => {
      const row = buildCreditRow(
        input({
          spec: lotte,
          agg: { unsettled: 0n, prevMonth: 1n, reviewCount: 0, reviewBase: 0n },
          balance: { balance: null, status: 'NOT_AVAILABLE' },
        }),
      );
      expect(row.hidden).toBe(false);
    });

    it('발송가능잔액(한도 잔존)은 재표시 판정에서 제외 — 여전히 숨김', () => {
      const row = buildCreditRow(
        input({
          spec: lotte,
          monthlyLimit: 9999n,
          agg: { unsettled: 0n, prevMonth: 0n, reviewCount: 0, reviewBase: 0n },
          balance: { balance: 9999n, status: 'AVAILABLE' },
        }),
      );
      expect(row.hidden).toBe(true);
    });
  });

  it('숨김 대상이 아닌 행은 항상 hidden=false', () => {
    expect(
      buildCreditRow(
        input({ agg: { unsettled: 0n, prevMonth: 0n, reviewCount: 0, reviewBase: 0n } }),
      ).hidden,
    ).toBe(false);
  });
});
