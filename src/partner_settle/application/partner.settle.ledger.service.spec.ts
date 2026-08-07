import { BadRequestException, UnprocessableEntityException } from '@nestjs/common';
import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';
import { IPriceAdjustment } from '../../user_discount/interface/price.adjustment';
import { PricingOutcome } from '../domain/partner.settle.pricing';
import { SubItemKeyUnresolvedError } from '../domain/settle.sub.item.key';
import { buildManualResolutionKey, SettleIdempotencyKeyError } from '../domain/settle.idempotency.key';
import { parseKstDateTime } from '../domain/settle.time';
import { LedgerAppendCommand, LedgerInvariantError, PartnerSettleLedgerService } from './partner.settle.ledger.service';
import { MissingTransactionError } from './partner.settle.transaction.guard';

const HISTORY_MATCH: PricingOutcome = {
  status: 'NORMAL',
  pricingResolution: 'HISTORY_MATCH',
  pricePercent: 1.5,
  priceAdjustment: IPriceAdjustment.DISCOUNT,
  appliedDiscountHistoryId: 77,
};

const SNAPSHOT = {
  price: 10_160_740,
  category: '모바일쿠폰',
  classificationId: null,
  brandNameKorean: 'CU',
};

/** 컬럼→값 한 쌍으로 뽑은 INSERT 파라미터. 저장값 검증은 전부 이걸 본다. */
type CapturedInsert = Record<string, unknown>;

function mockLedgerRepository(seed: Record<string, unknown>[] = []) {
  const rows: Record<string, unknown>[] = seed.map((row) => ({ ...row }));
  const inserts: CapturedInsert[] = [];
  let duplicateConstraintOnNextInsert: string | null = null;

  const lookup = { lockMode: null as string | null, id: null as number | null };
  const queryBuilder: { setLock: jest.Mock; where: jest.Mock; getOne: jest.Mock } = {
    setLock: jest.fn((mode: string) => {
      lookup.lockMode = mode;
      return queryBuilder;
    }),
    where: jest.fn((_condition: string, parameters: { id: number }) => {
      lookup.id = parameters.id;
      return queryBuilder;
    }),
    getOne: jest.fn(async () => rows.find((row) => row.id === lookup.id) ?? null),
  };

  const repository = {
    rows,
    inserts,
    queryBuilder,
    // 원장 경로는 ambient 트랜잭션이 없으면 시작조차 하지 않는다. 기본값은 "있음".
    manager: { queryRunner: { isTransactionActive: true } },
    failNextInsertAsDuplicate(constraint = 'uk_partner_settle_ledger_idempotency') {
      duplicateConstraintOnNextInsert = constraint;
    },
    query: jest.fn(async (sql: string, parameters: unknown[]) => {
      if (!sql.startsWith('INSERT INTO partner_settle_ledger')) return [];

      const columns = [...sql.matchAll(/`([a-z_]+)`/g)].map((matched) => matched[1]);
      const captured: CapturedInsert = {};
      columns.forEach((column, index) => (captured[column] = parameters[index]));
      inserts.push(captured);

      if (duplicateConstraintOnNextInsert) {
        const constraint = duplicateConstraintOnNextInsert;
        duplicateConstraintOnNextInsert = null;
        // MySQL 8 실제 형상. 제약 이름이 없으면 서비스가 멱등으로 삼켜선 안 되므로 메시지까지 재현한다.
        throw Object.assign(new Error('ER_DUP_ENTRY'), {
          errno: 1062,
          sqlMessage: `Duplicate entry 'x' for key 'partner_settle_ledger.${constraint}'`,
        });
      }

      rows.push({ id: rows.length + 1, ...toEntityShape(captured) });
      return { insertId: rows.length };
    }),
    findOne: jest.fn(
      async ({ where }: { where: { idempotencyKey: string } }) =>
        rows.find((row) => row.idempotencyKey === where.idempotencyKey) ?? null,
    ),
    find: jest.fn(async ({ where }: { where: { reversesLedgerId: number } }) =>
      rows.filter((row) => row.reversesLedgerId === where.reversesLedgerId),
    ),
    createQueryBuilder: jest.fn(() => queryBuilder),
  };

  return repository;
}

function toEntityShape(captured: CapturedInsert): Record<string, unknown> {
  const entity: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(captured)) {
    entity[column.replace(/_([a-z])/g, (_all, letter: string) => letter.toUpperCase())] = value;
  }
  return entity;
}

function build(outcome: PricingOutcome = HISTORY_MATCH, seed: Record<string, unknown>[] = []) {
  const ledgerRepository = mockLedgerRepository(seed);
  const pricingResolver = {
    lockPolicyForRead: jest.fn().mockResolvedValue(undefined),
    resolveAt: jest.fn().mockResolvedValue(outcome),
  };
  const service = new PartnerSettleLedgerService(ledgerRepository as never, pricingResolver as never);

  return { service, ledgerRepository, pricingResolver };
}

function appendCommand(overrides: Partial<LedgerAppendCommand> = {}): LedgerAppendCommand {
  return {
    partnerCompanyId: 4,
    subItem: { provider: IPartnerCompanyType.GALAXIA, giftKind: 'cpn' },
    sourceType: 'USAGE',
    orderDeliveryId: 100,
    galaxiaBarcodeLogId: 55,
    idempotencyKey: 'USE:55',
    occurredAt: parseKstDateTime('2026-07-31 23:59:59.123456'),
    baseAmount: 10_160_740n,
    vatCalculationMode: 'NONE',
    snapshot: SNAPSHOT,
    ...overrides,
  };
}

/** 역분개 테스트용 원본 row (TypeORM 이 돌려주는 형상 — bigint 는 문자열). */
function originalRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    partnerCompanyId: 4,
    subItemKey: 'GALAXIA_MOBILE',
    sourceType: 'USAGE',
    orderDeliveryId: 100,
    galaxiaBarcodeLogId: 55,
    occurredAt: new Date('2026-06-30T12:00:00.000'),
    baseAmount: '10000',
    discountAmount: '1000',
    receivingCommissionAmount: '0',
    givingCommissionAmount: '150',
    vatAmount: '15',
    vatCalculationMode: 'SEPARATE_ROUND',
    feeTotalAmount: '165',
    appliedPricePercent: '1.5000',
    appliedPriceAdjustment: IPriceAdjustment.DISCOUNT,
    appliedDiscountHistoryId: 77,
    pricingResolution: 'HISTORY_MATCH',
    settleAmount: '8835',
    idempotencyKey: 'USE:55',
    status: 'NORMAL',
    reviewCode: null,
    reversesLedgerId: null,
    ...overrides,
  };
}

describe('PartnerSettleLedgerService.lockForAppend', () => {
  it('정책 epoch 를 먼저 잡고 그다음 발송건을 FOR UPDATE 로 잡는다', async () => {
    const { service, ledgerRepository, pricingResolver } = build();

    await service.lockForAppend(4, 100);

    // 순서가 producer 마다 갈리면 일일 배치와 push 수신이 교차 데드락에 걸린다.
    expect(pricingResolver.lockPolicyForRead).toHaveBeenCalledWith(4, undefined);
    expect(ledgerRepository.query.mock.calls[0][0]).toContain('order_delivery');
    expect(ledgerRepository.query.mock.calls[0][0]).toContain('FOR UPDATE');
    expect(ledgerRepository.query.mock.calls[0][1]).toEqual([100]);
  });

  it('발송건이 없는 조정 경로는 발송건 잠금을 잡지 않는다', async () => {
    const { service, ledgerRepository } = build();

    await service.lockForAppend(4, null);

    expect(ledgerRepository.query).not.toHaveBeenCalled();
  });
});

/**
 * 트랜잭션 밖 호출은 잠금이 조용히 무력화되거나(raw FOR UPDATE), 원천 상태와 원장이 갈린다.
 * 열어주지 않고(=별도 트랜잭션을 만들지 않고) 계약 위반으로 끊는 것이 이 가드의 목적이다.
 */
describe('PartnerSettleLedgerService 트랜잭션 선행조건', () => {
  it('트랜잭션 밖에서는 잠금·append·역분개 모두 시작하지 않는다', async () => {
    const { service, ledgerRepository, pricingResolver } = build(HISTORY_MATCH, [originalRow()]);
    ledgerRepository.manager.queryRunner.isTransactionActive = false;

    await expect(service.lockForAppend(4, 100)).rejects.toBeInstanceOf(MissingTransactionError);
    await expect(service.appendLedger(appendCommand())).rejects.toBeInstanceOf(MissingTransactionError);
    await expect(
      service.appendReversal({
        reversesLedgerId: 1,
        baseIdempotencyKey: 'EXC:GALAXIA:USAGE:cancel-1',
        occurredAt: parseKstDateTime('2026-07-06 09:00:00'),
      }),
    ).rejects.toBeInstanceOf(MissingTransactionError);

    // 잠금도 INSERT 도 시도조차 하지 않는다 — 부분 write 없이 호출부에서 터진다.
    expect(pricingResolver.lockPolicyForRead).not.toHaveBeenCalled();
    expect(ledgerRepository.inserts).toHaveLength(0);
  });
});

describe('PartnerSettleLedgerService.appendLedger', () => {
  it('원천 마이크로초를 그대로 저장한다', async () => {
    const { service, ledgerRepository } = build();

    await service.appendLedger(appendCommand());

    // Date 로 넘기면 .123456 이 .123000 으로 잘려 증적 시각이 조용히 변조된다.
    expect(ledgerRepository.inserts[0].occurred_at).toBe('2026-07-31 23:59:59.123456');
  });

  it('§6.6 검증 상수대로 구성금액을 저장한다 (CU 10,160,740 × 1.5%)', async () => {
    const { service, ledgerRepository } = build();

    await service.appendLedger(appendCommand());

    const inserted = ledgerRepository.inserts[0];
    expect(inserted.giving_commission_amount).toBe('152411');
    expect(inserted.receiving_commission_amount).toBe('0');
    expect(inserted.fee_total_amount).toBe('152411');
    expect(inserted.settle_amount).toBe('10008329');
    expect(inserted.status).toBe('NORMAL');
    expect(inserted.pricing_resolution).toBe('HISTORY_MATCH');
    expect(inserted.applied_discount_history_id).toBe(77);
    expect(inserted.applied_price_percent).toBe('1.5');
  });
  it('정상 전이는 allocation 1을 명시해 raw INSERT에 함께 저장한다', async () => {
    const { service, ledgerRepository } = build();

    await service.appendLedger(
      appendCommand({
        transition: {
          observationId: 41,
          sequenceNo: 1,
          allocationNo: 1,
          sourceEventIdOrigin: 'PROVIDER',
        },
      }),
    );

    expect(ledgerRepository.inserts[0]).toMatchObject({
      transition_observation_id: 41,
      transition_sequence_no: 1,
      transition_allocation_no: 1,
      source_event_id_origin: 'PROVIDER',
    });
  });
  it('manager가 주어지면 그 repository에서 멱등 조회와 INSERT를 수행한다', async () => {
    const { service, ledgerRepository } = build();
    const manager = {
      manager: { queryRunner: { isTransactionActive: true } },
      getRepository: jest.fn(() => ledgerRepository),
    };

    await service.appendLedger(appendCommand(), manager as never);

    expect(manager.getRepository).toHaveBeenCalled();
    expect(ledgerRepository.inserts).toHaveLength(1);
  });

  it('같은 멱등키 재호출은 새 row 를 만들지 않고 기존 row 를 돌려준다', async () => {
    const { service, ledgerRepository } = build();

    const first = await service.appendLedger(appendCommand());
    const second = await service.appendLedger(appendCommand());

    expect(ledgerRepository.inserts).toHaveLength(1);
    expect(second).toBe(first);
  });

  it('동시 producer 가 같은 전이를 집어 UNIQUE 에 걸려도 기존 row 로 수렴한다', async () => {
    const { service, ledgerRepository } = build();
    ledgerRepository.rows.push({ id: 9, idempotencyKey: 'USE:55', status: 'NORMAL' });
    ledgerRepository.findOne.mockImplementationOnce(async () => null);
    ledgerRepository.failNextInsertAsDuplicate();

    const appended = await service.appendLedger(appendCommand());

    expect(appended).toMatchObject({ id: 9 });
  });

  it('멱등키가 아닌 전이 UNIQUE 충돌은 멱등으로 삼키지 않고 422 로 끊는다', async () => {
    const { service, ledgerRepository } = build();
    ledgerRepository.failNextInsertAsDuplicate('uk_partner_settle_ledger_transition');

    // 같은 멱등키 재조회는 실패한다(다른 사건이다). 삼키면 원인 없는 500 만 남는다.
    await expect(service.appendLedger(appendCommand())).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('orphan ingress 이중 정산 충돌도 원인 보존 422 다', async () => {
    const { service, ledgerRepository } = build();
    ledgerRepository.failNextInsertAsDuplicate('uk_partner_settle_ledger_orphan_settlement');

    const error = await service.appendLedger(appendCommand()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect((error as { cause?: unknown }).cause).toMatchObject({ errno: 1062 });
  });

  it('제약 이름을 읽을 수 없는 1062 는 멱등 수렴으로 삼키지 않는다', async () => {
    const { service, ledgerRepository } = build();
    ledgerRepository.query.mockImplementationOnce(async () => {
      throw Object.assign(new Error('ER_DUP_ENTRY'), { errno: 1062 });
    });

    await expect(service.appendLedger(appendCommand())).rejects.toMatchObject({ errno: 1062 });
  });

  it('이력 손상(COVERAGE_GAP)은 throw 하지 않고 금액을 비운 격리 row 로 남긴다', async () => {
    const { service, ledgerRepository } = build({
      status: 'NEEDS_REVIEW',
      reviewCode: 'COVERAGE_GAP',
      reason: '내부 hole',
    });

    await service.appendLedger(appendCommand());

    // throw 하면 같은 트랜잭션의 원천 상태 전이까지 롤백되어 배치가 그 발송건에서 영구히 막힌다.
    const inserted = ledgerRepository.inserts[0];
    expect(inserted.status).toBe('NEEDS_REVIEW');
    expect(inserted.review_code).toBe('COVERAGE_GAP');
    expect(inserted.review_resolution).toBe('PENDING');
    expect(inserted.base_amount).toBe('10160740');
    expect(inserted.applied_price_percent).toBeNull();
    expect(inserted.settle_amount).toBeNull();
    expect(inserted.pricing_resolution).toBeNull();
    expect(inserted.fee_total_amount).toBe('0');
  });

  it('스냅샷 결손(PRICE_UNRECOVERABLE)은 baseAmount 도 싣지 않는다', async () => {
    const { service, ledgerRepository } = build({
      status: 'NEEDS_REVIEW',
      reviewCode: 'PRICE_UNRECOVERABLE',
      reason: '스냅샷 없음',
    });

    await service.appendLedger(appendCommand());

    // DB CHECK 가 PRICE_UNRECOVERABLE 에 base_amount NULL 을 요구한다(신뢰할 수 없는 금액 배제).
    expect(ledgerRepository.inserts[0].base_amount).toBeNull();
    expect(ledgerRepository.inserts[0].occurred_at).toBe('2026-07-31 23:59:59.123456');
  });

  it('시각 복원 불가는 TIME_UNRECOVERABLE 로 격리하되 금액은 보존한다', async () => {
    const { service, ledgerRepository, pricingResolver } = build();

    await service.appendLedger(appendCommand({ occurredAt: null }));

    expect(pricingResolver.resolveAt).not.toHaveBeenCalled();
    expect(ledgerRepository.inserts[0].review_code).toBe('TIME_UNRECOVERABLE');
    expect(ledgerRepository.inserts[0].occurred_at).toBeNull();
    expect(ledgerRepository.inserts[0].base_amount).toBe('10160740');
  });

  it('provider 정의 외 코드는 금액 없이 UNKNOWN_PROVIDER_EVENT 로 격리한다', async () => {
    const { service, ledgerRepository } = build();

    await service.appendLedger(appendCommand({ unknownProviderEvent: true }));

    expect(ledgerRepository.inserts[0].review_code).toBe('UNKNOWN_PROVIDER_EVENT');
    expect(ledgerRepository.inserts[0].base_amount).toBeNull();
  });

  it('시각·금액이 모두 없으면 격리 row 조차 만들지 않는다', async () => {
    const { service, ledgerRepository } = build();

    await expect(service.appendLedger(appendCommand({ occurredAt: null, baseAmount: null }))).rejects.toBeInstanceOf(
      LedgerInvariantError,
    );
    expect(ledgerRepository.inserts).toHaveLength(0);
  });

  it('미등록 하위항목은 원장을 만들지 않고 실패시킨다', async () => {
    const { service, ledgerRepository } = build();

    await expect(
      service.appendLedger(
        appendCommand({ subItem: { provider: IPartnerCompanyType.GALAXIA, giftKind: 'dept', brandCode: 'EBR99999' } }),
      ),
    ).rejects.toBeInstanceOf(SubItemKeyUnresolvedError);
    // subItemKey 는 원장 불변값이라 추정 매핑으로 넣으면 하위항목 귀속이 영구히 틀어진다(§7 D6).
    expect(ledgerRepository.inserts).toHaveLength(0);
  });

  it('단건 상한을 넘는 baseAmount 는 400 으로 끊고 부분 write 를 남기지 않는다', async () => {
    const { service, ledgerRepository } = build();

    await expect(service.appendLedger(appendCommand({ baseAmount: 1_000_000_000_000_001n }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(ledgerRepository.inserts).toHaveLength(0);
  });
});

describe('PartnerSettleLedgerService.appendReversal', () => {
  const reversalCommand = {
    reversesLedgerId: 1,
    baseIdempotencyKey: 'EXC:GALAXIA:USAGE:cancel-1',
    occurredAt: parseKstDateTime('2026-07-06 09:00:00'),
  };

  it('전액취소는 원본 구성금액을 그대로 반대 부호로 복제한다', async () => {
    const { service, ledgerRepository, pricingResolver } = build(HISTORY_MATCH, [originalRow()]);

    await service.appendReversal(reversalCommand);

    const inserted = ledgerRepository.inserts[0];
    // 취소 시점 재계산 금지 — 그 사이 정산조건이 바뀌면 원본이 상쇄되지 않는다.
    expect(pricingResolver.resolveAt).not.toHaveBeenCalled();
    expect(inserted.base_amount).toBe('-10000');
    expect(inserted.discount_amount).toBe('-1000');
    expect(inserted.giving_commission_amount).toBe('-150');
    expect(inserted.vat_amount).toBe('-15');
    expect(inserted.fee_total_amount).toBe('-165');
    expect(inserted.settle_amount).toBe('-8835');
    expect(inserted.applied_price_percent).toBe('1.5000');
    expect(inserted.pricing_resolution).toBe('HISTORY_MATCH');
    expect(inserted.reverses_ledger_id).toBe(1);
  });
  it('복수 역분개 allocation은 같은 전이 순번에서 각각 raw INSERT로 보존한다', async () => {
    const { service, ledgerRepository } = build(HISTORY_MATCH, [originalRow()]);

    await service.appendReversal({
      ...reversalCommand,
      baseIdempotencyKey: 'EXC:multi-1',
      cancelBaseAmount: 3_000n,
      transition: {
        observationId: 88,
        sequenceNo: 2,
        allocationNo: 1,
        sourceEventIdOrigin: 'MANUAL',
      },
    });
    await service.appendReversal({
      ...reversalCommand,
      baseIdempotencyKey: 'EXC:multi-2',
      cancelBaseAmount: 7_000n,
      transition: {
        observationId: 88,
        sequenceNo: 2,
        allocationNo: 2,
        sourceEventIdOrigin: 'MANUAL',
      },
    });

    expect(ledgerRepository.inserts.map((inserted) => inserted.transition_allocation_no)).toEqual([1, 2]);
    expect(ledgerRepository.inserts.map((inserted) => inserted.transition_sequence_no)).toEqual([2, 2]);
  });

  it('역분개 멱등키에 원본 id suffix 를 붙인다', async () => {
    const { service, ledgerRepository } = build(HISTORY_MATCH, [originalRow()]);

    await service.appendReversal(reversalCommand);

    // 하나의 환불이 여러 원본을 걸치면 allocation 마다 자기 suffix 로 갈려 UNIQUE 충돌이 없다.
    expect(ledgerRepository.inserts[0].idempotency_key).toBe('EXC:GALAXIA:USAGE:cancel-1:1');
  });

  it('같은 취소 event 재수신은 새 row 를 만들지 않는다', async () => {
    const { service, ledgerRepository } = build(HISTORY_MATCH, [originalRow()]);

    const first = await service.appendReversal(reversalCommand);
    const second = await service.appendReversal(reversalCommand);

    expect(ledgerRepository.inserts).toHaveLength(1);
    expect(second).toBe(first);
  });

  it('원본을 FOR UPDATE 로 잡은 뒤 기존 역분개를 접는다', async () => {
    const { service, ledgerRepository } = build(HISTORY_MATCH, [originalRow()]);

    await service.appendReversal(reversalCommand);

    // 잠그지 않으면 동시 취소 2건이 같은 잔여를 두 번 쓴다.
    expect(ledgerRepository.queryBuilder.setLock).toHaveBeenCalledWith('pessimistic_write');
    expect(ledgerRepository.find).toHaveBeenCalledWith({ where: { reversesLedgerId: 1 } });
  });

  it('부분취소를 이어가면 마지막 취소가 전 항목 잔여를 정확히 소진한다', async () => {
    const { service, ledgerRepository } = build(HISTORY_MATCH, [originalRow()]);

    await service.appendReversal({ ...reversalCommand, baseIdempotencyKey: 'EXC:A', cancelBaseAmount: 3000n });
    await service.appendReversal({ ...reversalCommand, baseIdempotencyKey: 'EXC:B', cancelBaseAmount: 7000n });

    const fields = [
      'base_amount',
      'discount_amount',
      'receiving_commission_amount',
      'giving_commission_amount',
      'vat_amount',
      'fee_total_amount',
      'settle_amount',
    ] as const;

    for (const field of fields) {
      const reversedTotal = ledgerRepository.inserts.reduce(
        (sum, inserted) => sum + BigInt(inserted[field] as string),
        0n,
      );
      const originalValue = BigInt(originalRow()[camelOf(field)] as string);
      // 원본 + 역분개 누적 = 0 이어야 미정산 잔액이 남지 않는다(할인금액 스냅샷 포함).
      expect(originalValue + reversedTotal).toBe(0n);
    }

    // giving − receiving + vat = feeTotal 항등식은 각 역분개 row 에서도 유지된다.
    for (const inserted of ledgerRepository.inserts) {
      const identity =
        BigInt(inserted.giving_commission_amount as string) -
        BigInt(inserted.receiving_commission_amount as string) +
        BigInt(inserted.vat_amount as string);
      expect(identity).toBe(BigInt(inserted.fee_total_amount as string));
    }
  });

  it('잔여를 넘는 과다취소는 422 로 끊고 부분 write 를 남기지 않는다', async () => {
    const { service, ledgerRepository } = build(HISTORY_MATCH, [originalRow()]);

    await expect(service.appendReversal({ ...reversalCommand, cancelBaseAmount: 10_001n })).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(ledgerRepository.inserts).toHaveLength(0);
  });

  it('이미 전액 역분개된 원본은 다시 취소하지 않는다', async () => {
    const { service, ledgerRepository } = build(HISTORY_MATCH, [originalRow()]);
    await service.appendReversal(reversalCommand);

    await expect(
      service.appendReversal({ ...reversalCommand, baseIdempotencyKey: 'EXC:GALAXIA:USAGE:cancel-2' }),
    ).rejects.toBeInstanceOf(LedgerInvariantError);
    expect(ledgerRepository.inserts).toHaveLength(1);
  });

  it('격리 row 와 역분개 row 는 역분개 대상이 아니다', async () => {
    const isolated = originalRow({ id: 2, status: 'NEEDS_REVIEW', reviewCode: 'COVERAGE_GAP', settleAmount: null });
    const reversal = originalRow({ id: 3, reversesLedgerId: 1 });
    const { service } = build(HISTORY_MATCH, [isolated, reversal]);

    await expect(service.appendReversal({ ...reversalCommand, reversesLedgerId: 2 })).rejects.toBeInstanceOf(
      LedgerInvariantError,
    );
    await expect(service.appendReversal({ ...reversalCommand, reversesLedgerId: 3 })).rejects.toBeInstanceOf(
      LedgerInvariantError,
    );
  });

  it('없는 원본을 가리키면 실패시킨다', async () => {
    const { service } = build(HISTORY_MATCH, []);

    await expect(service.appendReversal(reversalCommand)).rejects.toBeInstanceOf(LedgerInvariantError);
  });
});

describe('buildManualResolutionKey', () => {
  it('resolution과 allocation 순번으로 수동 해소 멱등키를 만든다', () => {
    expect(buildManualResolutionKey(12, 3)).toBe('MANUAL_RESOLUTION:12:3');
  });

  it.each([0, -1, 1.5])('양의 정수가 아닌 입력은 거부한다: %p', (value) => {
    expect(() => buildManualResolutionKey(value, 1)).toThrow(SettleIdempotencyKeyError);
    expect(() => buildManualResolutionKey(1, value)).toThrow(SettleIdempotencyKeyError);
  });
});
function camelOf(column: string): string {
  return column.replace(/_([a-z])/g, (_all, letter: string) => letter.toUpperCase());
}
