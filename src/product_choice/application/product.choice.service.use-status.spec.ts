jest.mock('typeorm-transactional', () => ({
  IsolationLevel: { READ_COMMITTED: 'READ COMMITTED' },
  Transactional: () => () => undefined,
}));

import { ProductChoiceService } from './product.choice.service';
import { IProductUseStatus } from '../../product/interface/product.status';

// 초이스쿠폰 등록/수정 시 구성상품 상태에 따라 useStatus 를 보정하는지 검증.
// (구성상품 교체는 구성상품 useStatus 를 바꾸지 않으므로 ProductService cascade 가 돌지 않는다)
describe('ProductChoiceService - 구성상품 상태에 따른 초이스쿠폰 useStatus 보정', () => {
  const component = (id: number, useStatus: IProductUseStatus) => ({
    id,
    price: 1000,
    imagePath: 'img.png',
    useStatus,
  });

  // lastUseStatusHistory: 초이스쿠폰의 마지막 사용상태 이력. 자동/수동 판별에 쓰인다.
  const createService = (
    components: any[],
    currentUseStatus: IProductUseStatus = IProductUseStatus.USE,
    lastUseStatusHistory: any = null,
  ) => {
    const created: any[] = [];
    const updated: any[] = [];

    // 락 획득 순서를 기록한다. 초이스쿠폰 -> 구성상품 순서여야 syncChoiceUseStatus 와 엇갈려도
    // 데드락이 나지 않는다. 구성상품은 id 오름차순으로 잠근다.
    const lockOrder: string[] = [];
    const lockModes: string[] = [];
    // 구성상품 조회에 쓰인 id 목록과 정렬 방향
    let componentQueryIds: number[] = [];
    let componentOrderBy: [string, string] | null = null;

    const productRepository = {
      createQueryBuilder: jest.fn(() => {
        const qb: any = {
          setLock: jest.fn((mode: string) => {
            lockModes.push(mode);
            lockOrder.push('components');
            return qb;
          }),
          where: jest.fn((_condition: string, params?: { ids: number[] }) => {
            if (params?.ids) {
              componentQueryIds = params.ids;
            }
            return qb;
          }),
          orderBy: jest.fn((column: string, direction: string) => {
            componentOrderBy = [column, direction];
            return qb;
          }),
          getMany: jest.fn(async () => components),
        };
        return qb;
      }),
      // update 는 락 전에 존재 확인만 한다.
      countBy: jest.fn(async () => 1),
      findOne: jest.fn(async (options: any) => {
        if (options?.lock?.mode === 'pessimistic_write') {
          lockOrder.push('choiceProduct');
        }
        return { id: 100, type: 'CHOICE', useStatus: currentUseStatus };
      }),
      create: jest.fn((entity: any) => {
        created.push(entity);
        return entity;
      }),
      save: jest.fn(async (entity: any) => ({ ...entity, id: 100 })),
      update: jest.fn(async (_id: number, patch: any) => {
        updated.push(patch);
      }),
    };

    const productChoiceMappingRepository = {
      create: jest.fn((entity: any) => entity),
      insert: jest.fn(),
      softDelete: jest.fn(),
    };

    const histories: any[] = [];
    const productUpdateHistoryRepository = {
      insert: jest.fn(async (entity: any) => {
        histories.push(entity);
      }),
      // isAutoUnused 판별용. 마지막 사용상태 이력 1건을 돌려준다.
      findOne: jest.fn(async () => lastUseStatusHistory),
    };

    const service = new ProductChoiceService(
      productRepository as any,
      productChoiceMappingRepository as any,
      productUpdateHistoryRepository as any,
      {} as any,
    );

    return {
      service,
      created,
      updated,
      histories,
      lockModes,
      lockOrder,
      getComponentQueryIds: () => componentQueryIds,
      getComponentOrderBy: () => componentOrderBy,
    };
  };

  const user = { id: 1 } as any;

  const body = (useStatus: IProductUseStatus) => ({
    name: '초이스쿠폰',
    imagePath: 'img.png',
    productIdList: [1, 2],
    useStatus,
  });

  describe('create', () => {
    it('구성상품이 모두 사용이면 요청대로 사용으로 등록한다', async () => {
      const { service, created } = createService([
        component(1, IProductUseStatus.USE),
        component(2, IProductUseStatus.USE),
      ]);

      await service.create(user, body(IProductUseStatus.USE) as any);

      expect(created[0].useStatus).toBe(IProductUseStatus.USE);
    });

    it('미사용 구성상품이 있으면 사용으로 요청해도 미사용으로 등록한다', async () => {
      const { service, created } = createService([
        component(1, IProductUseStatus.USE),
        component(2, IProductUseStatus.UNUSED),
      ]);

      await service.create(user, body(IProductUseStatus.USE) as any);

      expect(created[0].useStatus).toBe(IProductUseStatus.UNUSED);
    });

    it('영구미사용 구성상품이 있어도 초이스쿠폰은 미사용으로 등록한다', async () => {
      const { service, created } = createService([
        component(1, IProductUseStatus.USE),
        component(2, IProductUseStatus.PERMANENTLY_UNUSED),
      ]);

      await service.create(user, body(IProductUseStatus.USE) as any);

      expect(created[0].useStatus).toBe(IProductUseStatus.UNUSED);
    });

    it('구성상품이 모두 정상이어도 미사용 요청은 존중한다', async () => {
      const { service, created } = createService([
        component(1, IProductUseStatus.USE),
        component(2, IProductUseStatus.USE),
      ]);

      await service.create(user, body(IProductUseStatus.UNUSED) as any);

      expect(created[0].useStatus).toBe(IProductUseStatus.UNUSED);
    });
  });

  describe('update', () => {
    it('구성상품 교체로 미사용 상품이 들어오면 미사용으로 수정한다', async () => {
      const { service, updated } = createService([
        component(1, IProductUseStatus.USE),
        component(2, IProductUseStatus.UNUSED),
      ]);

      await service.update(user, { id: 100, ...body(IProductUseStatus.USE) } as any);

      expect(updated[0].useStatus).toBe(IProductUseStatus.UNUSED);
    });

    it('미사용이던 초이스쿠폰도 관리자가 사용으로 요청하고 구성상품이 모두 정상이면 사용으로 되돌린다', async () => {
      const { service, updated } = createService(
        [component(1, IProductUseStatus.USE), component(2, IProductUseStatus.USE)],
        IProductUseStatus.UNUSED,
      );

      await service.update(user, { id: 100, ...body(IProductUseStatus.USE) } as any);

      expect(updated[0].useStatus).toBe(IProductUseStatus.USE);
    });

    it('구성상품이 모두 정상이어도 미사용 요청은 존중한다', async () => {
      const { service, updated } = createService([
        component(1, IProductUseStatus.USE),
        component(2, IProductUseStatus.USE),
      ]);

      await service.update(user, { id: 100, ...body(IProductUseStatus.UNUSED) } as any);

      expect(updated[0].useStatus).toBe(IProductUseStatus.UNUSED);
    });
  });

  // 사용상태 이력의 key 로 수동/자동을 구분한다.
  // 수동은 'useStatus', 구성상품 때문에 보정된 것은 'useStatusAuto' 로 남겨야
  // 이후 구성상품이 회복될 때 자동 복구 대상을 올바르게 가려낸다.
  describe('사용상태 변경 이력', () => {
    // 관리자가 USE 를 요청했는데 구성상품 때문에 UNUSED 로 보정된 경우는 자동 강등이다.
    // 수동 이력으로 남기면 이후 구성상품이 회복돼도 자동 복구되지 않아 요구사항에 어긋난다.
    it('등록 시 구성상품 때문에 보정된 미사용은 자동 key 로 남긴다', async () => {
      const { service, histories } = createService([
        component(1, IProductUseStatus.USE),
        component(2, IProductUseStatus.UNUSED),
      ]);

      await service.create(user, body(IProductUseStatus.USE) as any);

      expect(histories).toHaveLength(1);
      expect(histories[0].key).toBe('useStatusAuto');
      expect(histories[0].afterValue).toBe(IProductUseStatus.UNUSED);
    });

    it('수정 시 구성상품 때문에 보정된 미사용은 자동 key 로 남긴다', async () => {
      const { service, histories } = createService(
        [component(1, IProductUseStatus.USE), component(2, IProductUseStatus.UNUSED)],
        IProductUseStatus.USE,
      );

      await service.update(user, { id: 100, ...body(IProductUseStatus.USE) } as any);

      expect(histories).toHaveLength(1);
      expect(histories[0].key).toBe('useStatusAuto');
      expect(histories[0].afterValue).toBe(IProductUseStatus.UNUSED);
    });

    it('등록 시 관리자가 지정한 사용상태를 useStatus key 로 남긴다', async () => {
      const { service, histories } = createService([
        component(1, IProductUseStatus.USE),
        component(2, IProductUseStatus.USE),
      ]);

      await service.create(user, body(IProductUseStatus.UNUSED) as any);

      expect(histories).toHaveLength(1);
      expect(histories[0].key).toBe('useStatus');
      expect(histories[0].afterValue).toBe(IProductUseStatus.UNUSED);
    });

    it('수정으로 사용상태가 바뀌면 useStatus key 로 남긴다', async () => {
      const { service, histories } = createService(
        [component(1, IProductUseStatus.USE), component(2, IProductUseStatus.USE)],
        IProductUseStatus.USE,
      );

      await service.update(user, { id: 100, ...body(IProductUseStatus.UNUSED) } as any);

      expect(histories).toHaveLength(1);
      expect(histories[0].key).toBe('useStatus');
      expect(histories[0].beforeValue).toBe(IProductUseStatus.USE);
      expect(histories[0].afterValue).toBe(IProductUseStatus.UNUSED);
    });

    it('등록 시 구성상품을 쓰기 락으로 읽는다', async () => {
      const { service, lockModes } = createService([
        component(1, IProductUseStatus.USE),
        component(2, IProductUseStatus.USE),
      ]);

      await service.create(user, body(IProductUseStatus.USE) as any);

      expect(lockModes).toContain('pessimistic_write');
    });

    // 구성상품은 항상 id 오름차순으로 잠가야 서로 다른 요청이 엇갈려도 데드락이 나지 않는다.
    it('등록 시 구성상품을 id 오름차순으로 잠근다', async () => {
      const { service, getComponentQueryIds, getComponentOrderBy } = createService([
        component(1, IProductUseStatus.USE),
        component(2, IProductUseStatus.USE),
      ]);

      await service.create(user, { ...body(IProductUseStatus.USE), productIdList: [2, 1] } as any);

      expect(getComponentQueryIds()).toEqual([1, 2]);
      expect(getComponentOrderBy()).toEqual(['product.id', 'ASC']);
    });

    it('수정 시 구성상품을 쓰기 락으로 읽는다', async () => {
      const { service, lockModes } = createService([
        component(1, IProductUseStatus.USE),
        component(2, IProductUseStatus.USE),
      ]);

      await service.update(user, { id: 100, ...body(IProductUseStatus.USE) } as any);

      expect(lockModes).toContain('pessimistic_write');
    });

    // ProductService.updatePartial 은 구성상품을 save 로 갱신(행 락)한 뒤 초이스쿠폰을 잠근다.
    // 여기서 초이스쿠폰을 먼저 잠그면 두 경로가 엇갈릴 때 서로를 기다려 데드락이 난다.
    it('수정 시 구성상품을 먼저 잠그고 초이스쿠폰을 나중에 잠근다', async () => {
      const { service, lockOrder } = createService([
        component(1, IProductUseStatus.USE),
        component(2, IProductUseStatus.USE),
      ]);

      await service.update(user, { id: 100, ...body(IProductUseStatus.USE) } as any);

      expect(lockOrder).toEqual(['components', 'choiceProduct']);
    });

    // 락 조회가 중복 id 를 합치므로 길이 비교로 중복 요청을 거부해야 한다.
    // 통과시키면 같은 구성상품 매핑이 중복 저장된다.
    it('등록 시 구성상품 id 가 중복되면 거부한다', async () => {
      // 중복 id 를 합쳐 1건만 조회된 상황
      const { service } = createService([component(1, IProductUseStatus.USE)]);

      await expect(
        service.create(user, { ...body(IProductUseStatus.USE), productIdList: [1, 1] } as any),
      ).rejects.toThrow('존재하지 않거나 삭제된 상품이 있습니다.');
    });

    it('수정 시 구성상품 id 가 중복되면 거부한다', async () => {
      const { service } = createService([component(1, IProductUseStatus.USE)]);

      await expect(
        service.update(user, { id: 100, ...body(IProductUseStatus.USE), productIdList: [1, 1] } as any),
      ).rejects.toThrow('존재하지 않거나 삭제된 상품이 있습니다.');
    });

    // 자동으로 미사용된 초이스쿠폰을 관리자가 같은 값(UNUSED)으로 확정하는 경우.
    // 값이 안 바뀐다고 이력을 건너뛰면 마지막 이력이 자동 key 로 남아
    // 이후 구성상품이 회복될 때 자동으로 USE 가 되어 관리자 의도가 무시된다.
    it('자동 미사용 상태를 관리자가 미사용으로 확정하면 수동 이력으로 끊는다', async () => {
      const { service, histories } = createService(
        [component(1, IProductUseStatus.USE), component(2, IProductUseStatus.UNUSED)],
        IProductUseStatus.UNUSED,
        { key: 'useStatusAuto', afterValue: IProductUseStatus.UNUSED },
      );

      await service.update(user, { id: 100, ...body(IProductUseStatus.UNUSED) } as any);

      expect(histories).toHaveLength(1);
      expect(histories[0].key).toBe('useStatus');
      expect(histories[0].afterValue).toBe(IProductUseStatus.UNUSED);
    });

    it('이미 수동 미사용이면 같은 값으로 저장해도 이력을 남기지 않는다', async () => {
      const { service, histories } = createService(
        [component(1, IProductUseStatus.USE), component(2, IProductUseStatus.UNUSED)],
        IProductUseStatus.UNUSED,
        { key: 'useStatus', afterValue: IProductUseStatus.UNUSED },
      );

      await service.update(user, { id: 100, ...body(IProductUseStatus.UNUSED) } as any);

      expect(histories).toHaveLength(0);
    });

    // 보정으로 UNUSED 가 된 경우는 관리자 의도가 아니므로 자동 이력을 끊으면 안 된다.
    it('USE 요청이 구성상품 때문에 보정된 경우에는 수동 이력으로 끊지 않는다', async () => {
      const { service, histories } = createService(
        [component(1, IProductUseStatus.USE), component(2, IProductUseStatus.UNUSED)],
        IProductUseStatus.UNUSED,
        { key: 'useStatusAuto', afterValue: IProductUseStatus.UNUSED },
      );

      await service.update(user, { id: 100, ...body(IProductUseStatus.USE) } as any);

      expect(histories).toHaveLength(0);
    });

    // 자동 반영 도입 전에 만들어진 초이스쿠폰은 사용상태 이력이 없다.
    // 끊어야 할 자동 이력이 없으므로 값이 그대로면 이력도 남기지 않는다.
    it('사용상태 이력이 없으면 같은 값으로 저장해도 이력을 남기지 않는다', async () => {
      const { service, histories } = createService(
        [component(1, IProductUseStatus.USE), component(2, IProductUseStatus.USE)],
        IProductUseStatus.USE,
      );

      await service.update(user, { id: 100, ...body(IProductUseStatus.USE) } as any);

      expect(histories).toHaveLength(0);
    });
  });
});
