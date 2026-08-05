import { PartnerDiscountHistoryService } from './partner.discount.history.service';
import { IPartnerDiscountChangeType } from '../interface/partner.discount.change.type';
import { IPriceAdjustment } from '../../user_discount/interface/price.adjustment';
import { IUserDiscountCategory } from '../../user_discount/interface/user.discount.category';
import { IUserDiscountMethod } from '../../user_discount/interface/user.discount.method';
import { ICompareCondition } from '../../user_discount/interface/compare.condition';
import { PartnerDiscountScopeFields } from '../domain/discount.scope.key';

const SCOPE: PartnerDiscountScopeFields = {
  partnerCompanyId: 4,
  category: IUserDiscountCategory.PRODUCT_GROUP,
  classificationId: null,
  method: IUserDiscountMethod.BULK,
  primaryCategory: null,
  group: '모바일쿠폰',
  range: null,
  compareCondition: ICompareCondition.ALL,
};

function mockRepository(openInterval: unknown = null) {
  const queryBuilder = {
    setLock: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(openInterval),
  };
  return {
    queryBuilder,
    createQueryBuilder: jest.fn(() => queryBuilder),
    insert: jest.fn().mockResolvedValue({ identifiers: [{ id: 1 }] }),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    query: jest.fn().mockResolvedValue(undefined),
    increment: jest.fn().mockResolvedValue({ affected: 1 }),
  };
}

function build(openInterval: unknown = null) {
  const historyRepository = mockRepository(openInterval);
  const scopeRepository = mockRepository({ id: 1 });
  const epochRepository = mockRepository({ partnerCompanyId: SCOPE.partnerCompanyId });

  const service = new PartnerDiscountHistoryService(
    historyRepository as any,
    scopeRepository as any,
    epochRepository as any,
  );

  return { service, historyRepository, scopeRepository, epochRepository };
}

describe('PartnerDiscountHistoryService.lockPolicy', () => {
  it('넓은 정책 대상 앵커를 좁은 scope 앵커보다 먼저 잡는다', async () => {
    const { service, scopeRepository, epochRepository } = build();

    await service.lockPolicy(SCOPE);

    // 순서가 경로마다 갈리면 직접 CRUD 와 예약 cron 이 교차 데드락에 걸린다.
    expect(epochRepository.query).toHaveBeenCalledTimes(1);
    const anchorKeys = scopeRepository.query.mock.calls.map((call) => call[1][0]);
    expect(anchorKeys).toHaveLength(2);
    expect(anchorKeys[0]).toMatch(/^pt1\|/);
    expect(anchorKeys[1]).toMatch(/^sk1\|/);
  });

  it('앵커가 없으면 만들고 잠근다', async () => {
    const { service, scopeRepository } = build();

    await service.lockPolicy(SCOPE);

    expect(scopeRepository.query.mock.calls[0][0]).toContain('INSERT IGNORE');
    expect(scopeRepository.queryBuilder.setLock).toHaveBeenCalledWith('pessimistic_write');
  });
});

describe('PartnerDiscountHistoryService.recordCreate', () => {
  it('열린 구간이 없으면 요청 시각부터 여는 CREATE 구간을 만든다', async () => {
    const at = new Date('2026-08-03T10:00:00.000');
    const { service, historyRepository } = build(null);

    await service.recordCreate(SCOPE, { pricePercent: 5, priceAdjustment: IPriceAdjustment.DISCOUNT }, 9, at);

    expect(historyRepository.update).not.toHaveBeenCalled();
    expect(historyRepository.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        changeType: IPartnerDiscountChangeType.CREATE,
        pricePercent: 5,
        priceAdjustment: IPriceAdjustment.DISCOUNT,
        validFrom: at,
        validTo: null,
        changedBy: 9,
      }),
    );
  });

  it('열린 tombstone 을 마감한 시각과 새 구간 시작 시각이 정확히 같다', async () => {
    const at = new Date('2026-08-03T10:00:00.000');
    const open = { id: 11, validFrom: new Date('2026-07-01T00:00:00.000') };
    const { service, historyRepository } = build(open);

    await service.recordCreate(SCOPE, { pricePercent: 7, priceAdjustment: IPriceAdjustment.DISCOUNT }, 9, at);

    const closedAt = historyRepository.update.mock.calls[0][1].validTo;
    const openedAt = historyRepository.insert.mock.calls[0][0].validFrom;
    expect(closedAt).toEqual(openedAt);
  });

  it('같은 밀리초에 재생성해도 구간이 겹치지 않는다', async () => {
    // 마감만 밀고 새 구간은 원래 시각으로 넣으면 두 구간이 겹쳐 무결성 검사에 걸린다.
    const at = new Date('2026-08-03T10:00:00.000');
    const open = { id: 11, validFrom: at };
    const { service, historyRepository } = build(open);

    await service.recordCreate(SCOPE, { pricePercent: 7, priceAdjustment: IPriceAdjustment.DISCOUNT }, 9, at);

    const closedAt: Date = historyRepository.update.mock.calls[0][1].validTo;
    const openedAt: Date = historyRepository.insert.mock.calls[0][0].validFrom;

    expect(closedAt.getTime()).toBe(at.getTime() + 1);
    expect(openedAt).toEqual(closedAt);
    expect(openedAt.getTime()).toBeGreaterThan(open.validFrom.getTime());
  });
});

describe('PartnerDiscountHistoryService.recordDelete', () => {
  it('현재 구간을 마감하고 이어지는 tombstone 을 만든다', async () => {
    const at = new Date('2026-08-03T10:00:00.000');
    const open = { id: 11, validFrom: new Date('2026-07-01T00:00:00.000') };
    const { service, historyRepository } = build(open);

    await service.recordDelete(SCOPE, 9, at);

    expect(historyRepository.update.mock.calls[0][1].validTo).toEqual(at);
    expect(historyRepository.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        changeType: IPartnerDiscountChangeType.DELETE,
        pricePercent: null,
        priceAdjustment: null,
        validFrom: at,
        validTo: null,
      }),
    );
  });

  it('같은 밀리초에 생성 직후 삭제해도 구간이 겹치지 않는다', async () => {
    const at = new Date('2026-08-03T10:00:00.000');
    const open = { id: 11, validFrom: at };
    const { service, historyRepository } = build(open);

    await service.recordDelete(SCOPE, 9, at);

    const closedAt: Date = historyRepository.update.mock.calls[0][1].validTo;
    const tombstoneFrom: Date = historyRepository.insert.mock.calls[0][0].validFrom;

    expect(closedAt.getTime()).toBe(at.getTime() + 1);
    expect(tombstoneFrom).toEqual(closedAt);
  });

  it('열린 구간이 없어도 삭제 사실은 남긴다', async () => {
    const { service, historyRepository } = build(null);

    await service.recordDelete(SCOPE, 9, new Date('2026-08-03T10:00:00.000'));

    expect(historyRepository.update).not.toHaveBeenCalled();
    expect(historyRepository.insert).toHaveBeenCalledWith(
      expect.objectContaining({ changeType: IPartnerDiscountChangeType.DELETE }),
    );
  });

  it('마감 대상이 이미 다른 트랜잭션에 닫혔으면 실패시킨다', async () => {
    const { service, historyRepository } = build({ id: 11, validFrom: new Date('2026-07-01T00:00:00.000') });
    historyRepository.update.mockResolvedValue({ affected: 0 });

    await expect(service.recordDelete(SCOPE, 9, new Date('2026-08-03T10:00:00.000'))).rejects.toThrow();
  });
});

describe('PartnerDiscountHistoryService.bumpEpoch', () => {
  it('협력사 정책 카운터를 올린다', async () => {
    const { service, epochRepository } = build();

    await service.bumpEpoch(4);

    expect(epochRepository.increment).toHaveBeenCalledWith({ partnerCompanyId: 4 }, 'epoch', 1);
  });
});
