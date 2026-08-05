import { IsNull } from 'typeorm';
import { IPriceAdjustment } from '../../user_discount/interface/price.adjustment';
import { IUserDiscountCategory } from '../../user_discount/interface/user.discount.category';
import { IUserDiscountMethod } from '../../user_discount/interface/user.discount.method';
import { ICompareCondition } from '../../user_discount/interface/compare.condition';
import { IPartnerDiscountChangeType } from '../interface/partner.discount.change.type';
import { PartnerSettlePricingResolverService } from './partner.settle.pricing.resolver.service';
import { MissingTransactionError } from './partner.settle.transaction.guard';

const SNAPSHOT = {
  price: 10_000,
  category: '모바일쿠폰',
  classificationId: null,
  brandNameKorean: null,
};

function historyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 11,
    partnerCompanyId: 4,
    category: IUserDiscountCategory.PRODUCT_GROUP,
    classificationId: null,
    method: IUserDiscountMethod.BULK,
    primaryCategory: null,
    group: '모바일쿠폰',
    range: null,
    compareCondition: ICompareCondition.ALL,
    scopeKey: 'sk1|4|PRODUCT_GROUP|-|BULK|-|모바일쿠폰|-|ALL',
    changeType: IPartnerDiscountChangeType.CREATE,
    pricePercent: 5,
    priceAdjustment: IPriceAdjustment.DISCOUNT,
    validFrom: new Date('2026-01-01T00:00:00.000'),
    validTo: null,
    supersededByHistoryId: null,
    ...overrides,
  };
}

function build(rows: Record<string, unknown>[] = []) {
  const queryBuilder = {
    setLock: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue({ partnerCompanyId: 4 }),
  };
  const epochRepository = {
    // 잠금 경로는 ambient 트랜잭션 안에서만 성립한다. 기본값은 "있음".
    manager: { queryRunner: { isTransactionActive: true } },
    query: jest.fn().mockResolvedValue(undefined),
    createQueryBuilder: jest.fn(() => queryBuilder),
  };
  const historyRepository = { find: jest.fn().mockResolvedValue(rows) };
  const service = new PartnerSettlePricingResolverService(epochRepository as never, historyRepository as never);

  return { service, epochRepository, historyRepository, queryBuilder };
}

describe('PartnerSettlePricingResolverService.lockPolicyForRead', () => {
  it('epoch row 가 없으면 만들고 FOR SHARE 로 잡는다', async () => {
    const { service, epochRepository, queryBuilder } = build();

    await service.lockPolicyForRead(4);

    expect(epochRepository.query.mock.calls[0][0]).toContain('INSERT IGNORE');
    // writer 가 같은 row 를 FOR UPDATE 로 잡으므로 S/X 충돌로 직렬화된다. 배타락이면 원장 생성이 서로를 막는다.
    expect(queryBuilder.setLock).toHaveBeenCalledWith('pessimistic_read');
  });

  it('잠금에 실패하면 원장 계산을 진행하지 않는다', async () => {
    const { service, queryBuilder } = build();
    queryBuilder.getOne.mockResolvedValue(null);

    await expect(service.lockPolicyForRead(4)).rejects.toThrow();
  });

  it('트랜잭션 밖 호출은 epoch 생성조차 하지 않는다', async () => {
    const { service, epochRepository } = build();
    epochRepository.manager.queryRunner.isTransactionActive = false;

    // 여기서 INSERT IGNORE 가 먼저 커밋되면 잠금 없이 매입율을 읽는 경로가 열린다.
    await expect(service.lockPolicyForRead(4)).rejects.toBeInstanceOf(MissingTransactionError);
    expect(epochRepository.query).not.toHaveBeenCalled();
  });
});

describe('PartnerSettlePricingResolverService.resolveAt', () => {
  it('대체된(superseded) 구간은 timeline 재구성에서 제외한다', async () => {
    const { service, historyRepository } = build([historyRow()]);

    await service.resolveAt(4, new Date('2026-06-09T10:00:00.000'), SNAPSHOT);

    expect(historyRepository.find).toHaveBeenCalledWith({
      where: { partnerCompanyId: 4, supersededByHistoryId: IsNull() },
    });
  });

  it('occurredAt 을 커버하는 구간의 수수료율을 돌려준다', async () => {
    const { service } = build([historyRow()]);

    const outcome = await service.resolveAt(4, new Date('2026-06-09T10:00:00.000'), SNAPSHOT);

    expect(outcome).toMatchObject({
      status: 'NORMAL',
      pricingResolution: 'HISTORY_MATCH',
      pricePercent: 5,
      appliedDiscountHistoryId: 11,
    });
  });

  it('최초 설정 이전 시각은 격리가 아니라 0% 무매칭이다', async () => {
    const { service } = build([historyRow()]);

    const outcome = await service.resolveAt(4, new Date('2025-12-31T23:59:59.000'), SNAPSHOT);

    // pre-config 는 "그 시각 매입율이 없었다"는 사실이다. 격리하면 정상 발송건이 전부 멈춘다.
    expect(outcome).toMatchObject({ status: 'NORMAL', pricingResolution: 'NO_MATCH', pricePercent: 0 });
  });

  it('이력이 있는데 커버 구간이 없으면 이력 손상으로 격리한다', async () => {
    const { service } = build([
      historyRow({
        id: 11,
        validFrom: new Date('2026-01-01T00:00:00.000'),
        validTo: new Date('2026-03-01T00:00:00.000'),
      }),
      historyRow({ id: 12, validFrom: new Date('2026-05-01T00:00:00.000'), validTo: null }),
    ]);

    const outcome = await service.resolveAt(4, new Date('2026-04-01T00:00:00.000'), SNAPSHOT);

    expect(outcome).toMatchObject({ status: 'NEEDS_REVIEW', reviewCode: 'COVERAGE_GAP' });
  });
});
