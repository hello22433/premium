import { UserSyncProductService } from './user.sync.product.service';
import { IProductUseStatus } from '../../product/interface/product.status';
import { IUserSyncProductStatus } from '../interface/user.sync.product.status';

describe('UserSyncProductService.getList - useStatus 필터', () => {
  const createService = () => {
    const subQueryBuilders: any[] = [];
    const qb: any = {
      leftJoinAndSelect: jest.fn(() => qb),
      innerJoinAndSelect: jest.fn(() => qb),
      andWhere: jest.fn((conditionOrFactory?: unknown) => {
        if (typeof conditionOrFactory === 'function') {
          conditionOrFactory(qb);
        }
        return qb;
      }),
      setParameter: jest.fn(() => qb),
      orderBy: jest.fn(() => qb),
      skip: jest.fn(() => qb),
      take: jest.fn(() => qb),
      getManyAndCount: jest.fn(async () => [
        [
          {
            id: 1,
            createdAt: new Date('2026-07-15T00:00:00.000Z'),
            name: '이벤트',
            code: 'EVT',
            status: IUserSyncProductStatus.ACTIVE,
            businessUser: { company: { businessName: '고객사' } },
            userSyncProductEventMappings: [
              { id: 10, productId: 100, product: { id: 100, useStatus: IProductUseStatus.USE } },
              { id: 11, productId: 101, product: null },
            ],
          },
        ],
        1,
      ]),
      subQuery: jest.fn(() => {
        const subQb: any = {
          select: jest.fn(() => subQb),
          from: jest.fn(() => subQb),
          innerJoin: jest.fn(() => subQb),
          where: jest.fn(() => subQb),
          andWhere: jest.fn(() => subQb),
          getQuery: jest.fn(() => 'SUB_QUERY'),
        };
        subQueryBuilders.push(subQb);
        return subQb;
      }),
    };

    const eventRepository = {
      createQueryBuilder: jest.fn(() => qb),
    };

    const service = new UserSyncProductService(eventRepository as any, {} as any, {} as any, {} as any);

    return { service, qb, subQueryBuilders };
  };

  it('목록의 등록상품수는 살아있는 USE 상품만 센다', async () => {
    const { service, qb } = createService();

    const result = await service.getList({
      page: 1,
      take: 10,
    } as any);

    expect(qb.leftJoinAndSelect).toHaveBeenCalledWith(
      'userSyncProductEventMappings.product',
      'syncProduct',
      'syncProduct.deletedAt IS NULL AND syncProduct.useStatus = :syncProductUseStatus',
      { syncProductUseStatus: IProductUseStatus.USE },
    );
    expect(result.list[0].syncProductCount).toBe(1);
  });

  it('상품명 검색 서브쿼리도 USE 상품만 대상으로 한다', async () => {
    const { service, subQueryBuilders } = createService();

    await service.getList({
      page: 1,
      take: 10,
      searchKeyword: '상품',
      productName: '상품',
    } as any);

    expect(subQueryBuilders).toHaveLength(2);
    for (const subQb of subQueryBuilders) {
      expect(subQb.andWhere).toHaveBeenCalledWith('p.useStatus = :syncProductUseStatus');
    }
  });
});
