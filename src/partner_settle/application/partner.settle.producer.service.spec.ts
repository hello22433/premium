import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';
import { SubItemKeyUnresolvedError } from '../domain/settle.sub.item.key';
import { parseKstDateTime } from '../domain/settle.time';
import {
  PartnerSettleProducerService,
  SettlementContext,
  SettlementEvent,
} from './partner.settle.producer.service';

const OCCURRED_AT = parseKstDateTime('2026-07-31 23:59:59.123456');

function build(flagOn = true) {
  const featureFlag = { isEnabledFor: jest.fn(() => flagOn) };
  const ledgerService = {
    lockForAppend: jest.fn().mockResolvedValue(undefined),
    appendLedger: jest.fn().mockResolvedValue({ id: 1 }),
    appendReversal: jest.fn().mockResolvedValue({ id: 2 }),
  };
  const service = new PartnerSettleProducerService(featureFlag as never, ledgerService as never);

  return { service, featureFlag, ledgerService };
}

function context(overrides: Partial<SettlementContext> = {}): SettlementContext {
  return {
    provider: IPartnerCompanyType.GALAXIA,
    partnerCompanyId: 4,
    orderDeliveryId: 100,
    settleMethod: 'PER_PRODUCT',
    snapshot: { price: 10_000, category: '모바일쿠폰', classificationId: null, brandNameKorean: null },
    subItem: { giftKind: 'cpn' },
    vatCalculationMode: 'SEPARATE_ROUND',
    ...overrides,
  };
}

function event(overrides: Partial<SettlementEvent> = {}): SettlementEvent {
  return {
    kind: 'USAGE',
    idempotencyKey: 'USE:55',
    occurredAt: OCCURRED_AT,
    baseAmount: 10_000n,
    galaxiaBarcodeLogId: 55,
    ...overrides,
  };
}

describe('PartnerSettleProducerService.record', () => {
  it('flag off 면 잠금도 조회도 하지 않는다', async () => {
    const { service, ledgerService } = build(false);

    const result = await service.record(context(), event());

    // off 상태에서 기존 배치·push·CS 동작이 1비트도 바뀌면 안 된다(§4.6).
    expect(result).toBeNull();
    expect(ledgerService.lockForAppend).not.toHaveBeenCalled();
    expect(ledgerService.appendLedger).not.toHaveBeenCalled();
  });

  it('상품 settleMethod 와 다른 사건은 원장을 만들지 않는다', async () => {
    const { service, ledgerService } = build();

    // 한국문화진흥(PER_ISSUANCE) 사용조회로 원장을 만들면 발행 시 정산분을 두 번 센다(§14 O5).
    const result = await service.record(
      context({ settleMethod: 'PER_ISSUANCE', provider: IPartnerCompanyType.CULTURELAND }),
      event({ kind: 'USAGE' }),
    );

    expect(result).toBeNull();
    expect(ledgerService.lockForAppend).not.toHaveBeenCalled();
  });

  it('settleMethod 를 모르면 원장을 만들지 않는다', async () => {
    const { service, ledgerService } = build();

    await expect(service.record(context({ settleMethod: null }), event())).resolves.toBeNull();
    expect(ledgerService.appendLedger).not.toHaveBeenCalled();
  });

  it('정산 사건이면 잠금을 먼저 잡고 원장을 append 한다', async () => {
    const { service, ledgerService } = build();

    await service.record(context(), event());

    expect(ledgerService.lockForAppend).toHaveBeenCalledWith(4, 100, undefined);
    expect(ledgerService.lockForAppend.mock.invocationCallOrder[0]).toBeLessThan(
      ledgerService.appendLedger.mock.invocationCallOrder[0],
    );
  });

  it('sourceType 은 감지한 훅이 아니라 settleMethod 가 정한다', async () => {
    const { service, ledgerService } = build();

    await service.record(context({ settleMethod: 'PER_EXCHANGE' }), event({ kind: 'EXCHANGE' }));

    expect(ledgerService.appendLedger.mock.calls[0][0]).toMatchObject({
      sourceType: 'EXCHANGE',
      subItem: { provider: IPartnerCompanyType.GALAXIA, giftKind: 'cpn' },
      vatCalculationMode: 'SEPARATE_ROUND',
      occurredAt: OCCURRED_AT,
      baseAmount: 10_000n,
    });
  });

  it('VAT 정책을 안 넘기면 NONE 으로 둔다', async () => {
    const { service, ledgerService } = build();

    await service.record(context({ vatCalculationMode: undefined }), event());

    // 임의 기본값(별도/포함)을 넣으면 수수료에 없는 VAT 가 생긴다. 정책은 PR1D config 소유다.
    expect(ledgerService.appendLedger.mock.calls[0][0].vatCalculationMode).toBe('NONE');
  });

  it('하위항목 미등록은 원장 없이 실패시킨다', async () => {
    const { service, ledgerService } = build();
    ledgerService.appendLedger.mockRejectedValue(new SubItemKeyUnresolvedError('brand.code 미등록'));

    await expect(service.record(context(), event())).rejects.toBeInstanceOf(SubItemKeyUnresolvedError);
  });
});

describe('PartnerSettleProducerService.recordCancellation', () => {
  it('flag off 면 역분개도 만들지 않는다', async () => {
    const { service, ledgerService } = build(false);

    const result = await service.recordCancellation(context(), {
      kind: 'USAGE',
      reversesLedgerId: 1,
      baseIdempotencyKey: 'USE:56',
      occurredAt: OCCURRED_AT,
    });

    expect(result).toBeNull();
    expect(ledgerService.appendReversal).not.toHaveBeenCalled();
  });

  it('취소는 잠금 후 역분개로 넘긴다', async () => {
    const { service, ledgerService } = build();

    await service.recordCancellation(context(), {
      kind: 'USAGE',
      reversesLedgerId: 1,
      baseIdempotencyKey: 'USE:56',
      occurredAt: OCCURRED_AT,
      cancelBaseAmount: 3_000n,
    });

    expect(ledgerService.lockForAppend).toHaveBeenCalledWith(4, 100, undefined);
    expect(ledgerService.appendReversal.mock.calls[0][0]).toMatchObject({
      reversesLedgerId: 1,
      baseIdempotencyKey: 'USE:56',
      cancelBaseAmount: 3_000n,
    });
  });
});

describe('PartnerSettleProducerService.isSettlementTarget', () => {
  it('훅이 inbox·orphan 처리 전에 정산 대상 여부를 먼저 물어볼 수 있다', () => {
    const { service } = build();

    expect(service.isSettlementTarget(context(), 'USAGE')).toBe(true);
    expect(service.isSettlementTarget(context(), 'EXCHANGE')).toBe(false);
  });
});
