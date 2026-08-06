import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';
import {
  buildInboxEvidenceKey,
  buildIssuanceKey,
  buildProviderTransitionKey,
  buildReversalKey,
  buildUnresolvedBaseKey,
  buildUsageKey,
  SettleIdempotencyKeyError,
} from './settle.idempotency.key';
import { resolveSubItemKey, SubItemKeyUnresolvedError, SUB_ITEM_KEY_NONE } from './settle.sub.item.key';

describe('멱등키 (정본 §5.1)', () => {
  it('sourceType 별 키 형식을 고정한다', () => {
    expect(buildIssuanceKey(41)).toBe('ISS:41');
    expect(buildUsageKey(7)).toBe('USE:7');
    expect(buildProviderTransitionKey(IPartnerCompanyType.GALAXIA, 'EXCHANGE', 'fp-abc')).toBe(
      'EXC:GALAXIA:EXCHANGE:fp-abc',
    );
  });

  it('provider·sourceType namespace 로 교차 협력사 ID 충돌을 막는다', () => {
    const a = buildProviderTransitionKey(IPartnerCompanyType.DAOU, 'EXCHANGE', '1001');
    const b = buildProviderTransitionKey(IPartnerCompanyType.GIFT_SHOW, 'EXCHANGE', '1001');
    expect(a).not.toBe(b);
  });

  it('역분개는 단일 원본이어도 :{reversesLedgerId} suffix 를 붙인다', () => {
    const base = buildProviderTransitionKey(IPartnerCompanyType.GALAXIA, 'USAGE', 'fp-1');
    expect(buildReversalKey(base, 10)).toBe('EXC:GALAXIA:USAGE:fp-1:10');
    // 하나의 환불이 원본 2건을 걸쳐도 allocation 마다 키가 갈린다.
    expect(buildReversalKey(base, 10)).not.toBe(buildReversalKey(base, 11));
  });

  it('provider 원천 ID 가 서버 예약 namespace 를 침범하면 거부한다', () => {
    expect(() =>
      buildProviderTransitionKey(IPartnerCompanyType.GALAXIA, 'EXCHANGE', 'MANUAL_LEDGER:9'),
    ).toThrow(SettleIdempotencyKeyError);
    expect(() =>
      buildProviderTransitionKey(IPartnerCompanyType.GALAXIA, 'EXCHANGE', 'MANUAL_RESOLUTION:9:1'),
    ).toThrow(SettleIdempotencyKeyError);
  });

  it('증적 없는 전이는 키를 만들지 않는다 (UNRESOLVED 보관 대상)', () => {
    expect(() => buildProviderTransitionKey(IPartnerCompanyType.DAOU, 'EXCHANGE', '  ')).toThrow(
      SettleIdempotencyKeyError,
    );
  });

  it('미복원 관측 identity 는 base + evidence 로 구성된다', () => {
    expect(buildUnresolvedBaseKey(IPartnerCompanyType.DAOU, 55, 'EXCHANGE')).toBe('UNRES:DAOU:55:EXCHANGE');
    expect(buildInboxEvidenceKey(120)).toBe('INBOX:120');
  });
});

describe('subItemKey 매핑 (§14 O1·O2)', () => {
  it('갤럭시아 cpn 은 모바일 쿠폰, dept 는 brand.code 화이트리스트다', () => {
    expect(resolveSubItemKey({ provider: IPartnerCompanyType.GALAXIA, giftKind: 'cpn' })).toBe('GALAXIA_MOBILE');
    expect(
      resolveSubItemKey({ provider: IPartnerCompanyType.GALAXIA, giftKind: 'dept', brandCode: 'EBR00025' }),
    ).toBe('GALAXIA_LOTTE');
    expect(
      resolveSubItemKey({ provider: IPartnerCompanyType.GALAXIA, giftKind: 'dept', brandCode: 'EBR00037' }),
    ).toBe('GALAXIA_GALLERIA');
  });

  it('미등록 dept brand.code 는 추정하지 않고 거부한다', () => {
    expect(() =>
      resolveSubItemKey({ provider: IPartnerCompanyType.GALAXIA, giftKind: 'dept', brandCode: 'EBR99999' }),
    ).toThrow(SubItemKeyUnresolvedError);
    expect(() =>
      resolveSubItemKey({ provider: IPartnerCompanyType.GALAXIA, giftKind: 'dept', brandCode: null }),
    ).toThrow(SubItemKeyUnresolvedError);
  });

  it('한국문화진흥은 유효기간 60/1825 만 매핑하고 그 외는 거부한다 (else → 5Y 금지)', () => {
    expect(
      resolveSubItemKey({ provider: IPartnerCompanyType.CULTURELAND, snapshotProductExpireDay: 60 }),
    ).toBe('CULTURE_60D');
    expect(
      resolveSubItemKey({ provider: IPartnerCompanyType.CULTURELAND, snapshotProductExpireDay: 1825 }),
    ).toBe('CULTURE_5Y');
    for (const expireDay of [null, 0, 365]) {
      expect(() =>
        resolveSubItemKey({
          provider: IPartnerCompanyType.CULTURELAND,
          snapshotProductExpireDay: expireDay as number | null,
        }),
      ).toThrow(SubItemKeyUnresolvedError);
    }
  });

  it('그 외 협력사는 NONE 이다', () => {
    for (const provider of [
      IPartnerCompanyType.SSG,
      IPartnerCompanyType.GIFT_SHOW,
      IPartnerCompanyType.DAOU,
      IPartnerCompanyType.GIFTIEL,
    ]) {
      expect(resolveSubItemKey({ provider })).toBe(SUB_ITEM_KEY_NONE);
    }
  });
});
