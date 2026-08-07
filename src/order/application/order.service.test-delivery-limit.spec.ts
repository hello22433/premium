jest.mock('typeorm-transactional', () => ({
  Transactional: () => (_target: unknown, _key: unknown, descriptor: PropertyDescriptor) => descriptor,
  Propagation: { REQUIRED: 'REQUIRED', REQUIRES_NEW: 'REQUIRES_NEW' },
  runOnTransactionCommit: jest.fn((callback: () => void) => callback()),
}));

jest.mock('../../delivery/infra/delivery.create.coupon.image', () => ({
  DeliveryCreateCouponImage: jest.fn().mockResolvedValue({ path: 'test-coupon.png' }),
}));

import { BadRequestException } from '@nestjs/common';
import { OrderService } from './order.service';
import { DeliveryCreateCouponImage } from '../../delivery/infra/delivery.create.coupon.image';
import { IUserAuthority } from '../../user/interface/user.authority';
import { ViewScopeType } from '../../entity/user.view.scope.entity';
import { IOrderStatus } from '../interface/order.status';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';

/**
 * 테스트 발송(testDelivery) 정책 검증:
 *  - 운영관리자/최고관리자는 상품당 2회 제한을 우회한다 (횟수제한 예외로 막히지 않음).
 *  - 기업관리자(CORPORATE_ADMIN)는 상품당 2회 제한이 유지된다.
 *  - 한도 용량은 발송 전 조건부 UPDATE(test_delivery_count < 2) 로 원자 선점되어 동시 요청 초과가 차단된다.
 *  - 발송 실패 시 저장한 이력 정리 + 선점 한도 보상 차감(-1) 이 수행된다.
 *  - 이력은 TEMP(저장) → WAIT(발송 직전) → COMPLETE(발송 성공 후) 로 전이한다.
 *  - 크래시로 남은 TEMP 잔류는 다음 요청 진입 시 정리하고 한도를 회수한다.
 *  - orderId 와 orderProductMapping.orderId 불일치(IDOR) 는 거부된다.
 *  - assertOrderInViewScope 로 조회 범위 밖 주문은 거부된다.
 *
 * 실제 DB 없이 mock repository 로 로직을 평가한다. 조건부 UPDATE 의 affected 값을 주입해
 * 한도 선점/보상 흐름을 시뮬레이션한다.
 */
describe('OrderService testDelivery 정책 (횟수제한/IDOR)', () => {
  // mockRejectedValueOnce 등이 다음 케이스로 새지 않도록 기본 성공 동작으로 되돌린다.
  beforeEach(() => {
    (DeliveryCreateCouponImage as jest.Mock).mockReset().mockResolvedValue({ path: 'test-coupon.png' });
  });

  const LIMIT_MSG = '테스트발송은 상품당 최대 2회입니다.';
  const MISMATCH_MSG = '주문 정보와 상품 정보가 일치하지 않습니다.';

  // 주문 소유자 userId=10, 주문 id=77.
  const ownedOrder = {
    id: 77,
    userId: 10,
    operationUserId: null,
    clientUserId: null,
  };

  /** assertOrderInViewScope 용 scope-aware order query builder. */
  const createScopeBuilder = () => {
    let inScope = true;
    const builder: any = {
      innerJoin: jest.fn().mockReturnThis(),
      withDeleted: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn((clause: string, params: Record<string, unknown>) => {
        if (clause.includes('order.userId = :userId')) {
          const uid = params.userId;
          inScope = ownedOrder.userId === uid || ownedOrder.operationUserId === uid || ownedOrder.clientUserId === uid;
        }
        return builder;
      }),
      getCount: jest.fn(() => Promise.resolve(inScope ? 1 : 0)),
    };
    return builder;
  };

  /** orderProductMapping 조회 builder. testDeliveryCount/ orderId 를 주입한다. */
  const createMappingBuilder = (mapping: any, mappingAlive = true) => {
    const builder: any = {
      innerJoinAndSelect: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn(() => Promise.resolve(mapping)),
      // 이력 저장 직전 매핑 생존 확인. false 면 updateTemp 가 매핑을 재생성한 상황이다.
      getExists: jest.fn(() => Promise.resolve(mappingAlive)),
    };
    return builder;
  };

  /**
   * 조건부 UPDATE(update().set().where().andWhere().execute()) 체인 mock.
   * execute() 는 affectedQueue 에서 순서대로 { affected } 를 반환한다.
   * 한도 선점(claim)과 보상 차감(rollback) 이 각각 이 체인을 쓴다.
   */
  const createUpdateBuilder = (affectedQueue: number[]) => {
    const captured: Array<{ set: any; where: string[]; isSoftDelete?: boolean }> = [];
    let current: { set: any; where: string[]; isSoftDelete?: boolean };
    const builder: any = {
      update: jest.fn(() => {
        current = { set: undefined, where: [] };
        return builder;
      }),
      // 진입부 잔류 정리(softDelete)는 별도 큐(staleAffected)로 결과를 준다.
      softDelete: jest.fn(() => {
        current = { set: undefined, where: [], isSoftDelete: true };
        return builder;
      }),
      set: jest.fn((v: any) => {
        current.set = v;
        return builder;
      }),
      where: jest.fn((clause: string) => {
        current.where.push(clause);
        return builder;
      }),
      andWhere: jest.fn((clause: string) => {
        current.where.push(clause);
        return builder;
      }),
      execute: jest.fn(() => {
        captured.push(current);
        if (current.isSoftDelete) {
          const clause = current.where.join(' ');
          // 실패 보상 경로의 이력 삭제(id 지정). 삭제 성공 여부가 한도 차감 여부를 가른다.
          if (clause.includes('id = :id')) {
            if (builder.discardShouldThrow) {
              return Promise.reject(new Error('DB down'));
            }
            return Promise.resolve({ affected: builder.discardAffected ?? 1 });
          }
          // 잔류 정리는 선점분(limit_claimed = 1)과 미선점분(= 0)을 각각 지운다.
          // 한도 회수는 선점분 affected 만 써야 하므로 결과를 분리해서 준다.
          if (clause.includes('limit_claimed = 0')) {
            return Promise.resolve({ affected: builder.staleUnclaimedAffected ?? 0 });
          }
          return Promise.resolve({ affected: builder.staleAffected ?? 0 });
        }
        const affected = affectedQueue.length > 0 ? affectedQueue.shift()! : 1;
        return Promise.resolve({ affected });
      }),
    };
    builder.captured = captured;
    return builder;
  };

  const buildService = (
    mapping: any,
    opts: {
      claimAffected?: number[];
      confirmAffected?: number[];
      staleAffected?: number;
      staleUnclaimedAffected?: number;
      mappingAlive?: boolean;
    } = {},
  ) => {
    const fullMapping = {
      id: 5,
      orderId: 77,
      testDeliveryCount: 0,
      sendType: 'IMMEDIATE',
      sendRequestAt: null,
      sendMethod: 'ALIM_TALK',
      sendTitle: '테스트 제목',
      sendContent: '테스트 내용',
      topImagePath: null,
      midImagePath: null,
      galaxiaDuration: null,
      product: {
        imagePath: 'product.png',
        name: '테스트 상품',
        type: 'GENERAL',
        expireDay: 30,
        galaxiaDuration: null,
        brand: { nameKorean: '테스트 브랜드' },
        partnerCompany: null,
      },
      order: {
        id: 77,
        type: 'GENERAL',
        status: IOrderStatus.DELIVERY_COMPLETE,
        user: { fromPhoneNumber: '0212345678' },
      },
      ...mapping,
    };
    const service = Object.create(OrderService.prototype) as any;
    service.orderRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(createScopeBuilder()),
    };

    // 한도 선점(claim), 보상 차감(rollback) 이 공유하는 update 체인.
    const updateBuilder = createUpdateBuilder(opts.claimAffected ? [...opts.claimAffected] : []);
    service.orderProductMappingRepository = {
      createQueryBuilder: jest.fn((alias?: string) =>
        alias ? createMappingBuilder(fullMapping, opts.mappingAlive ?? true) : updateBuilder,
      ),
      increment: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    service.updateBuilder = updateBuilder;

    service.logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() };
    service.orderDeliveryRepository = {
      findOne: jest.fn().mockResolvedValue(null),
    };
    // 상태 전이(WAIT/COMPLETE) UPDATE 와 진입부 잔류 정리(softDelete) 가 이 체인을 공유한다.
    const confirmBuilder = createUpdateBuilder(opts.confirmAffected ? [...opts.confirmAffected] : []);
    // 진입부 잔류 정리 결과. 기본은 정리 대상 없음(affected=0).
    confirmBuilder.staleAffected = opts.staleAffected ?? 0;
    confirmBuilder.staleUnclaimedAffected = opts.staleUnclaimedAffected ?? 0;
    service.testOrderDeliveryRepository = {
      save: jest.fn().mockResolvedValue({ id: 101 }),
      softDelete: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(() => confirmBuilder),
    };
    service.confirmBuilder = confirmBuilder;
    service.deliveryBatchService = {
      oneSend: jest.fn().mockResolvedValue(true),
    };
    service.cryptoCipher = {
      encryptDeliveryTarget: jest.fn((value: string) => `enc:${value}`),
    };
    service.userRepository = {
      findOne: jest.fn().mockResolvedValue({ id: undefined, companyId: 100, departmentId: 5 }),
    };
    service.userViewScopeRepository = {
      findOne: jest.fn().mockResolvedValue({ scopeType: ViewScopeType.SELF, getDeptIdList: () => [] }),
    };
    return service;
  };

  const owner = (authority: IUserAuthority) => ({ id: 10, email: 'o@o.com', authority });
  const body = (over?: Partial<{ orderId: number; orderProductMappingId: number; deliveryTarget: string }>) => ({
    orderId: 77,
    orderProductMappingId: 5,
    deliveryTarget: '01012345678',
    ...over,
  });

  // 실패 보상 경로의 이력 삭제(id 지정 softDelete)만 뽑는다. 진입부 잔류 정리(mapping 단위)와 구분한다.
  const rollbackDeletes = (service: any) =>
    service.confirmBuilder.captured.filter(
      (c: any) => c.isSoftDelete && c.where.some((w: string) => w.includes('id = :id')),
    );

  it('기업관리자: 한도 선점 UPDATE 가 0행이면(잔여 없음) 횟수제한으로 거부되고 발송하지 않는다', async () => {
    // claim UPDATE affected=0 → 한도 초과 → 발송 전 차단.
    const service = buildService({ id: 5, orderId: 77, testDeliveryCount: 2 }, { claimAffected: [0] });
    await expect(service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body())).rejects.toThrow(LIMIT_MSG);
    expect(service.deliveryBatchService.oneSend).not.toHaveBeenCalled();
    // 선점 전 차단이라 이력 저장도 없다.
    expect(service.testOrderDeliveryRepository.save).not.toHaveBeenCalled();
  });

  it('한도 선점은 test_delivery_count < 2 조건부 UPDATE(선증가) 로 발송 전에 수행된다', async () => {
    const service = buildService({ id: 5, orderId: 77, testDeliveryCount: 0 }, { claimAffected: [1] });

    await expect(service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body())).resolves.toBeUndefined();

    const claim = service.updateBuilder.captured[0];
    expect(claim.where.some((c: string) => c.includes('test_delivery_count < :maxLimitCount'))).toBe(true);
    expect(typeof claim.set.testDeliveryCount).toBe('function');
    expect(claim.set.testDeliveryCount()).toContain('test_delivery_count + 1');
    // 선점 성공 후 발송.
    expect(service.deliveryBatchService.oneSend).toHaveBeenCalled();
  });

  // 관리자는 무제한이라 한도(test_delivery_count)를 아예 건드리지 않는다.
  // 여기서 카운트를 올리면 기업관리자 한도(상품당 2회)를 관리자 발송이 대신 소진한다.
  it('운영관리자: 한도를 증가시키지 않고 무제한 발송된다 (우회)', async () => {
    const service = buildService({ id: 5, orderId: 77, testDeliveryCount: 99 });

    await expect(service.testDelivery(owner(IUserAuthority.OPERATION_ADMIN), body())).resolves.toBeUndefined();

    expect(service.deliveryBatchService.oneSend).toHaveBeenCalled();
    // 조건부 선점 UPDATE 도, increment 도 호출되지 않는다.
    expect(service.orderProductMappingRepository.increment).not.toHaveBeenCalled();
    expect(service.updateBuilder.captured.length).toBe(0);
    // 선점하지 않은 건으로 기록되어야 잔류 정리가 한도를 회수하지 않는다.
    expect(service.testOrderDeliveryRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ limitClaimed: false }),
    );
  });

  it('최고관리자: 한도를 증가시키지 않고 무제한 발송된다 (우회)', async () => {
    const service = buildService({ id: 5, orderId: 77, testDeliveryCount: 99 });

    await expect(service.testDelivery(owner(IUserAuthority.SUPER_ADMIN), body())).resolves.toBeUndefined();

    expect(service.deliveryBatchService.oneSend).toHaveBeenCalled();
    expect(service.orderProductMappingRepository.increment).not.toHaveBeenCalled();
    expect(service.updateBuilder.captured.length).toBe(0);
    expect(service.testOrderDeliveryRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ limitClaimed: false }),
    );
  });

  /**
   * 권한 혼합: 관리자 발송이 기업관리자 한도를 소진하면 안 된다.
   * 관리자 경로가 카운트를 올리면(과거 동작) 기업관리자가 한 번도 안 썼는데 2회 제한에 막힌다.
   */
  describe('권한 혼합 시나리오', () => {
    it('운영관리자가 2회 발송해도 기업관리자는 여전히 2회 발송할 수 있다', async () => {
      // 실제 DB 카운트를 모사한다. 조건부 UPDATE 는 count < 2 일 때만 +1 한다.
      let count = 0;
      const service = buildService({ id: 5, orderId: 77, testDeliveryCount: 0 });
      // execute 를 대체하므로 원본이 하던 captured 기록을 여기서 직접 수행한다.
      const originalExecute = service.updateBuilder.execute;
      service.updateBuilder.execute = jest.fn(() => {
        const result = originalExecute();
        const captured = service.updateBuilder.captured;
        const clause = captured[captured.length - 1]?.where.join(' ') ?? '';
        if (clause.includes('test_delivery_count < :maxLimitCount')) {
          if (count >= 2) return Promise.resolve({ affected: 0 });
          count += 1;
          return Promise.resolve({ affected: 1 });
        }
        return result;
      });
      // increment 도 같은 카운터에 반영한다. 관리자 경로가 카운트를 올리면 여기서 드러나야 한다.
      service.orderProductMappingRepository.increment = jest.fn(() => {
        count += 1;
        return Promise.resolve({ affected: 1 });
      });

      // 운영관리자 2회 — 카운트는 그대로 0 이어야 한다.
      await service.testDelivery(owner(IUserAuthority.OPERATION_ADMIN), body());
      await service.testDelivery(owner(IUserAuthority.OPERATION_ADMIN), body());
      expect(count).toBe(0);

      // 기업관리자는 자기 몫 2회를 온전히 쓸 수 있다.
      await expect(service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body())).resolves.toBeUndefined();
      await expect(service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body())).resolves.toBeUndefined();
      expect(count).toBe(2);

      // 3회째는 한도 초과로 차단된다.
      await expect(service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body())).rejects.toThrow(LIMIT_MSG);
      expect(service.deliveryBatchService.oneSend).toHaveBeenCalledTimes(4);
    });

    it('기업관리자가 한도를 모두 쓴 뒤에도 운영관리자는 계속 발송할 수 있다', async () => {
      const service = buildService({ id: 5, orderId: 77, testDeliveryCount: 2 }, { claimAffected: [0] });

      await expect(service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body())).rejects.toThrow(LIMIT_MSG);
      await expect(service.testDelivery(owner(IUserAuthority.OPERATION_ADMIN), body())).resolves.toBeUndefined();

      expect(service.deliveryBatchService.oneSend).toHaveBeenCalledTimes(1);
    });

    it('관리자 발송이 실패해도 한도를 보상 차감하지 않는다 (선점한 적이 없다)', async () => {
      const service = buildService({ id: 5, orderId: 77, testDeliveryCount: 1 });
      service.deliveryBatchService.oneSend.mockResolvedValue(false);

      await expect(service.testDelivery(owner(IUserAuthority.OPERATION_ADMIN), body())).rejects.toThrow(
        '테스트 발송에 실패했습니다. 수신자 정보를 확인해주세요.',
      );

      // 이력은 정리하되, 한도 UPDATE 는 선점(+1)도 보상(-1)도 없어야 한다.
      expect(rollbackDeletes(service).length).toBe(1);
      expect(service.updateBuilder.captured.length).toBe(0);
    });
  });

  it('IDOR: mapping.orderId 가 요청 orderId 와 다르면 거부된다', async () => {
    const service = buildService({ id: 5, orderId: 88, testDeliveryCount: 0 });
    await expect(service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body())).rejects.toThrow(MISMATCH_MSG);
  });

  it('스코프 밖 호출자(주문 미소유)는 assertOrderInViewScope 에서 거부된다', async () => {
    const service = buildService({ id: 5, orderId: 77, testDeliveryCount: 0 });
    const intruder = { id: 999, email: 'x@x.com', authority: IUserAuthority.CORPORATE_ADMIN };
    await expect(service.testDelivery(intruder, body())).rejects.toBeInstanceOf(BadRequestException);
  });

  // 동시 요청이 잔여 1회를 초과하지 못한다: 조건부 UPDATE 가 용량을 원자 선점한다.
  describe('동시성: 한도 초과 차단', () => {
    it('잔여 1회에서 동시 2건 요청 시 한 건만 발송되고 다른 건은 한도 초과로 차단된다', async () => {
      // 조건부 UPDATE 는 DB 가 직렬화한다. 첫 요청 affected=1(선점 성공), 둘째 affected=0(잔여 소진).
      const service = buildService({ id: 5, orderId: 77, testDeliveryCount: 1 }, { claimAffected: [1, 0] });
      let nextId = 101;
      service.testOrderDeliveryRepository.save.mockImplementation(() => Promise.resolve({ id: nextId++ }));

      const r1 = service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body());
      const r2 = service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body());
      const results = await Promise.allSettled([r1, r2]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter(
        (r) => r.status === 'rejected' && String((r as PromiseRejectedResult).reason?.message).includes(LIMIT_MSG),
      );

      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
      expect(service.deliveryBatchService.oneSend).toHaveBeenCalledTimes(1);
    });
  });

  // 발송 실패 경로: 저장한 이력 정리 + 선점 한도 보상 차감(-1).
  describe('발송 실패 경로', () => {
    it('oneSend 가 false 면 실패 예외 + 이력 삭제 + 선점 한도 보상 차감(-1)', async () => {
      const service = buildService({ id: 5, orderId: 77, testDeliveryCount: 0 }, { claimAffected: [1] });
      service.deliveryBatchService.oneSend.mockResolvedValue(false);

      await expect(service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body())).rejects.toThrow(
        '테스트 발송에 실패했습니다. 수신자 정보를 확인해주세요.',
      );

      expect(rollbackDeletes(service).length).toBe(1);
      // 선점 한도 보상: claim 의 첫 execute(+1) 이후 rollback 의 두 번째 execute(-1).
      const compensation = service.updateBuilder.captured[1];
      expect(compensation).toBeDefined();
      expect(compensation.set.testDeliveryCount()).toContain('test_delivery_count - 1');
      expect(compensation.where.some((c: string) => c.includes('test_delivery_count > 0'))).toBe(true);
    });

    it('oneSend 가 예외를 던져도 이력 삭제 + 보상 차감 후 원 예외를 전파한다', async () => {
      const service = buildService({ id: 5, orderId: 77, testDeliveryCount: 0 }, { claimAffected: [1] });
      service.deliveryBatchService.oneSend.mockRejectedValue(new Error('provider timeout'));

      await expect(service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body())).rejects.toThrow(
        'provider timeout',
      );

      expect(rollbackDeletes(service).length).toBe(1);
      expect(service.updateBuilder.captured[1]?.set.testDeliveryCount()).toContain('test_delivery_count - 1');
    });

    // 삭제와 차감이 갈리면 한도가 이중 회수된다. 행이 TEMP·limit_claimed=1 로 남은 채 차감까지 되면
    // grace 경과 후 잔류 정리가 또 회수해 기업관리자가 2회 제한을 넘겨 발송할 수 있다.
    it('이력 삭제가 실패하면 한도 보상 차감도 하지 않는다 (잔류 정리가 1회만 회수)', async () => {
      const service = buildService({ id: 5, orderId: 77, testDeliveryCount: 0 }, { claimAffected: [1] });
      service.deliveryBatchService.oneSend.mockResolvedValue(false);
      service.confirmBuilder.discardShouldThrow = true;

      await expect(service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body())).rejects.toThrow(
        '테스트 발송에 실패했습니다. 수신자 정보를 확인해주세요.',
      );

      // 선점(+1) 외에 보상(-1) UPDATE 가 없어야 한다.
      expect(service.updateBuilder.captured.length).toBe(1);
      expect(service.logger.error).toHaveBeenCalled();
      // soft delete 실패로 행이 잔류해도 COMPLETE 확정은 없어 성공 이력으로 노출되지 않는다.
      expect(service.testOrderDeliveryRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: IOrderDeliveryStatus.TEMP }),
      );
      const statuses = service.confirmBuilder.captured
        .filter((c: any) => !c.isSoftDelete)
        .map((c: any) => c.set.status);
      expect(statuses).not.toContain(IOrderDeliveryStatus.COMPLETE);
    });

    it('이력이 이미 정리돼 삭제가 0행이면 한도 보상 차감을 하지 않는다 (이중 회수 방지)', async () => {
      // 잔류 정리가 먼저 이 행을 지우면서 한도까지 회수한 상황. 여기서 또 차감하면 2회 제한이 무너진다.
      const service = buildService({ id: 5, orderId: 77, testDeliveryCount: 0 }, { claimAffected: [1] });
      service.deliveryBatchService.oneSend.mockResolvedValue(false);
      service.confirmBuilder.discardAffected = 0;

      await expect(service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body())).rejects.toThrow(
        '테스트 발송에 실패했습니다. 수신자 정보를 확인해주세요.',
      );

      expect(rollbackDeletes(service).length).toBe(1);
      // 선점(+1) 외에 보상(-1) UPDATE 가 없어야 한다.
      expect(service.updateBuilder.captured.length).toBe(1);
      expect(service.logger.warn).toHaveBeenCalled();
    });

    // 준비 단계(이미지 생성·이력 저장)도 선점 이후의 외부 I/O 라 실패 시 한도를 보상해야 한다.
    // 보상하지 않으면 실제 발송 없이 2회 한도만 영구 소진된다.
    it('쿠폰 이미지 생성이 실패하면 이력 저장 전이라도 선점 한도를 보상 차감(-1)한다', async () => {
      const service = buildService({ id: 5, orderId: 77, testDeliveryCount: 0 }, { claimAffected: [1] });
      (DeliveryCreateCouponImage as jest.Mock).mockRejectedValueOnce(new Error('image gen failed'));

      await expect(service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body())).rejects.toThrow(
        'image gen failed',
      );

      // 이력 저장 전 실패라 저장·삭제는 일어나지 않는다.
      expect(service.testOrderDeliveryRepository.save).not.toHaveBeenCalled();
      expect(rollbackDeletes(service).length).toBe(0);
      // 발송도 하지 않았으므로 선점한 한도는 되돌아와야 한다.
      expect(service.deliveryBatchService.oneSend).not.toHaveBeenCalled();
      const compensation = service.updateBuilder.captured[1];
      expect(compensation).toBeDefined();
      expect(compensation.set.testDeliveryCount()).toContain('test_delivery_count - 1');
      expect(compensation.where.some((c: string) => c.includes('test_delivery_count > 0'))).toBe(true);
    });

    it('테스트 발송 이력 저장이 실패하면 선점 한도를 보상 차감(-1)한다', async () => {
      const service = buildService({ id: 5, orderId: 77, testDeliveryCount: 0 }, { claimAffected: [1] });
      service.testOrderDeliveryRepository.save.mockRejectedValue(new Error('save failed'));

      await expect(service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body())).rejects.toThrow('save failed');

      expect(service.deliveryBatchService.oneSend).not.toHaveBeenCalled();
      // 저장 자체가 실패해 이력 id 가 없으므로 삭제는 시도하지 않는다.
      expect(rollbackDeletes(service).length).toBe(0);
      expect(service.updateBuilder.captured[1]?.set.testDeliveryCount()).toContain('test_delivery_count - 1');
    });

    it('발송 준비 중 매핑이 재생성됐으면 이력을 저장하지 않고 발송 전에 중단한다', async () => {
      const service = buildService(
        { id: 5, orderId: 77, testDeliveryCount: 0 },
        { claimAffected: [1], mappingAlive: false },
      );

      await expect(service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body())).rejects.toThrow(
        '주문이 저장되어 테스트 발송이 취소되었습니다. 다시 시도해주세요.',
      );

      // 이력을 남기지 않아야 조회 불가능한 고아 행이 생기지 않는다.
      expect(service.testOrderDeliveryRepository.save).not.toHaveBeenCalled();
      expect(service.deliveryBatchService.oneSend).not.toHaveBeenCalled();
      expect(service.updateBuilder.captured[1]?.set.testDeliveryCount()).toContain('test_delivery_count - 1');
    });

    it('mapping 이 없으면 발송·선점 없이 거부된다', async () => {
      const service = buildService({ id: 5, orderId: 77, testDeliveryCount: 0 });
      service.orderProductMappingRepository.createQueryBuilder = jest.fn((alias?: string) =>
        alias ? createMappingBuilder(null) : service.updateBuilder,
      );

      await expect(service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body())).rejects.toThrow(
        '해당 주문-상품이 존재하지 않습니다.',
      );

      expect(service.deliveryBatchService.oneSend).not.toHaveBeenCalled();
      expect(service.testOrderDeliveryRepository.save).not.toHaveBeenCalled();
    });

    it('가드(IDOR) 위반 시 발송도 한도 선점도 이력 저장도 일어나지 않는다', async () => {
      const service = buildService({ id: 5, orderId: 88, testDeliveryCount: 0 });

      await expect(service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body())).rejects.toThrow(MISMATCH_MSG);

      expect(service.deliveryBatchService.oneSend).not.toHaveBeenCalled();
      expect(service.updateBuilder.captured.length).toBe(0);
      expect(service.testOrderDeliveryRepository.save).not.toHaveBeenCalled();
    });
  });

  /**
   * 크래시로 rollbackTestDelivery 가 실행되지 못한 잔류 이력을 다음 요청 진입 시 정리한다.
   * TEMP(발송 전 크래시)만 대상이고, WAIT(발송 여부 불명)은 중복 발송 위험 때문에 손대지 않는다.
   */
  describe('진입부 잔류 정리', () => {
    // 선점분(limit_claimed = 1) 정리 — 이 건의 affected 만 한도 회수에 쓰인다.
    const findStaleCleanup = (service: any) =>
      service.confirmBuilder.captured.find(
        (c: any) => c.isSoftDelete && c.where.join(' ').includes('limit_claimed = 1'),
      );
    // 미선점분(관리자) 정리 — 이력만 지우고 한도는 건드리지 않는다.
    const findUnclaimedCleanup = (service: any) =>
      service.confirmBuilder.captured.find(
        (c: any) => c.isSoftDelete && c.where.join(' ').includes('limit_claimed = 0'),
      );

    it('grace 경과한 TEMP 잔류를 정리하고 한도를 회수한다', async () => {
      const service = buildService(
        { id: 5, orderId: 77, testDeliveryCount: 2 },
        { claimAffected: [1], staleAffected: 1 },
      );

      await expect(service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body())).resolves.toBeUndefined();

      const cleanup = findStaleCleanup(service);
      expect(cleanup).toBeDefined();
      const where = cleanup.where.join(' ');
      expect(where).toContain('status = :temp');
      expect(where).toContain('order_product_mapping_id = :orderProductMappingId');
      // 회수량(affected)을 그대로 쓰므로 선점한 건만 대상이어야 한다.
      expect(where).toContain('limit_claimed = 1');
      // 진행 중인 정상 흐름을 잔류로 오인하지 않도록 grace 를 둔다.
      expect(where).toContain('INTERVAL 600 SECOND');

      // 회수한 횟수만큼 한도를 되돌린다. 0 미만으로는 내려가지 않는다.
      const recovery = service.updateBuilder.captured[0];
      expect(recovery.set.testDeliveryCount()).toContain('GREATEST(test_delivery_count - 1, 0)');
    });

    it('관리자(한도 미선점) TEMP 잔류는 정리하되 한도를 회수하지 않는다', async () => {
      // 선점분 잔류는 없고(0), 관리자 잔류만 1건 있는 상황.
      const service = buildService(
        { id: 5, orderId: 77, testDeliveryCount: 1 },
        { claimAffected: [1], staleAffected: 0, staleUnclaimedAffected: 1 },
      );

      await expect(service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body())).resolves.toBeUndefined();

      // 관리자 잔류도 화면에 남지 않도록 지운다.
      const unclaimed = findUnclaimedCleanup(service);
      expect(unclaimed).toBeDefined();
      expect(unclaimed.where.join(' ')).toContain('status = :temp');

      // 한도 UPDATE 는 이번 요청의 선점(+1) 하나뿐 — 회수(GREATEST) 는 없어야 한다.
      expect(service.updateBuilder.captured.length).toBe(1);
      expect(service.updateBuilder.captured[0].set.testDeliveryCount()).toContain('test_delivery_count + 1');
    });

    it('선점분과 관리자 잔류가 섞여 있으면 선점분 수만큼만 회수한다', async () => {
      const service = buildService(
        { id: 5, orderId: 77, testDeliveryCount: 2 },
        { claimAffected: [1], staleAffected: 1, staleUnclaimedAffected: 3 },
      );

      await expect(service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body())).resolves.toBeUndefined();

      // 관리자 잔류 3건은 회수량에 포함되지 않는다(-4 가 아니라 -1).
      const recovery = service.updateBuilder.captured[0];
      expect(recovery.set.testDeliveryCount()).toContain('GREATEST(test_delivery_count - 1, 0)');
    });

    it('정리 대상이 없으면 한도를 건드리지 않는다', async () => {
      const service = buildService({ id: 5, orderId: 77, testDeliveryCount: 0 }, { claimAffected: [1] });

      await expect(service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body())).resolves.toBeUndefined();

      // 한도 UPDATE 는 선점(+1) 하나뿐이어야 한다.
      expect(service.updateBuilder.captured.length).toBe(1);
      expect(service.updateBuilder.captured[0].set.testDeliveryCount()).toContain('test_delivery_count + 1');
    });

    it('정리는 한도 선점보다 먼저 수행된다 (회수분을 이번 요청이 쓸 수 있어야 한다)', async () => {
      const service = buildService(
        { id: 5, orderId: 77, testDeliveryCount: 2 },
        { claimAffected: [1], staleAffected: 1 },
      );
      // 진입부 정리는 선점분·미선점분 두 번 호출된다. 순서 판정은 첫 호출 시점만 본다.
      let claimedBeforeCleanup: boolean | null = null;
      const originalSoftDelete = service.confirmBuilder.softDelete;
      service.confirmBuilder.softDelete = jest.fn(() => {
        if (claimedBeforeCleanup === null) {
          claimedBeforeCleanup = service.updateBuilder.captured.length > 0;
        }
        return originalSoftDelete();
      });

      await service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body());

      expect(claimedBeforeCleanup).toBe(false);
    });

    it('WAIT 잔류는 미경보 건만 1회 마킹하고 삭제·확정하지 않는다', async () => {
      const service = buildService({ id: 5, orderId: 77, testDeliveryCount: 0 }, { claimAffected: [1] });

      await expect(service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body())).resolves.toBeUndefined();

      const escalation = service.confirmBuilder.captured.find(
        (c: any) => !c.isSoftDelete && c.set?.opsEscalatedAt !== undefined,
      );
      expect(escalation).toBeDefined();
      const where = escalation.where.join(' ');
      expect(where).toContain('status = :wait');
      // 중복 경보 방지.
      expect(where).toContain('ops_escalated_at IS NULL');
      expect(where).toContain('INTERVAL 600 SECOND');
      // 발송됐을 수 있으므로 COMPLETE 확정도 삭제도 하지 않는다.
      expect(escalation.set.status).toBeUndefined();
    });

    it('정리가 실패해도 발송 요청은 계속된다', async () => {
      const service = buildService({ id: 5, orderId: 77, testDeliveryCount: 0 }, { claimAffected: [1] });
      service.confirmBuilder.softDelete.mockImplementationOnce(() => {
        throw new Error('cleanup failed');
      });

      await expect(service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body())).resolves.toBeUndefined();

      expect(service.deliveryBatchService.oneSend).toHaveBeenCalled();
      expect(service.logger.error).toHaveBeenCalled();
    });
  });

  // 진입부 정리(softDelete·경보 마킹)를 걸러낸 상태 전이 UPDATE 만 뽑는다.
  const statusTransitions = (service: any) =>
    service.confirmBuilder.captured.filter((c: any) => !c.isSoftDelete && c.set?.status !== undefined);

  // 이력 상태: TEMP(저장) → WAIT(발송 직전) → COMPLETE(발송 성공 후).
  // 크래시로 잔류했을 때 발송 여부를 구분할 수 있어야 진입부 정리가 미발송 건만 되돌린다.
  describe('이력 상태 전이(TEMP → WAIT → COMPLETE)', () => {
    it('TEMP 저장 → 발송 직전 WAIT → 발송 성공 후 COMPLETE 순으로 전이한다', async () => {
      const service = buildService({ id: 5, orderId: 77, testDeliveryCount: 0 }, { claimAffected: [1] });

      await expect(service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body())).resolves.toBeUndefined();

      expect(service.testOrderDeliveryRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: IOrderDeliveryStatus.TEMP }),
      );
      const [wait, confirm] = statusTransitions(service);
      expect(wait.set.status).toBe(IOrderDeliveryStatus.WAIT);
      expect(confirm.set.status).toBe(IOrderDeliveryStatus.COMPLETE);
      // 확정은 WAIT 인 행만 전환한다.
      expect(confirm.where.some((c: string) => c.includes('status = :wait'))).toBe(true);
    });

    it('WAIT 전환은 발송 전에, COMPLETE 확정은 발송 후에 수행된다', async () => {
      const service = buildService({ id: 5, orderId: 77, testDeliveryCount: 0 }, { claimAffected: [1] });
      let statusesDuringSend: string[] = [];
      service.deliveryBatchService.oneSend.mockImplementation(() => {
        statusesDuringSend = statusTransitions(service).map((c: any) => c.set.status);
        return Promise.resolve(true);
      });

      await expect(service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body())).resolves.toBeUndefined();

      // 발송 시점에는 WAIT 만 기록돼 있어야 한다. COMPLETE 가 미리 있으면 발송 중 성공 이력으로 노출된다.
      expect(statusesDuringSend).toEqual([IOrderDeliveryStatus.WAIT]);
      expect(statusTransitions(service).length).toBe(2);
    });

    it('WAIT 전환이 실패하면 발송하지 않고 이력 삭제 + 한도 보상한다', async () => {
      const service = buildService({ id: 5, orderId: 77, testDeliveryCount: 0 }, { claimAffected: [1] });
      // WAIT 전환만 실패시킨다. 다른 execute 는 정상이어야 보상 경로(삭제 + 차감)를 관찰할 수 있다.
      const originalSet = service.confirmBuilder.set;
      service.confirmBuilder.set = jest.fn((v: any) => {
        if (v?.status === IOrderDeliveryStatus.WAIT) {
          throw new Error('wait update failed');
        }
        return originalSet(v);
      });

      await expect(service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body())).rejects.toThrow(
        'wait update failed',
      );

      // 아직 발송 전이므로 되돌린다.
      expect(service.deliveryBatchService.oneSend).not.toHaveBeenCalled();
      expect(rollbackDeletes(service).length).toBe(1);
      expect(service.updateBuilder.captured[1]?.set.testDeliveryCount()).toContain('test_delivery_count - 1');
    });

    it('WAIT 전환은 살아있는 TEMP 행만 대상으로 한다', async () => {
      const service = buildService({ id: 5, orderId: 77, testDeliveryCount: 0 }, { claimAffected: [1] });

      await expect(service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body())).resolves.toBeUndefined();

      const [wait] = statusTransitions(service);
      expect(wait.where.some((c: string) => c.includes('status = :temp'))).toBe(true);
      expect(wait.where.some((c: string) => c.includes('deleted_at IS NULL'))).toBe(true);
    });

    it('WAIT 전환이 0행이면(잔류 정리가 이력을 회수함) 발송하지 않고 한도 보상도 하지 않는다', async () => {
      // 이 요청이 정지된 사이 다른 인스턴스가 TEMP 이력을 soft delete 하고 한도까지 회수한 상황.
      // 그대로 발송하면 성공 이력 없이 한도만 소진되고, 여기서 보상하면 회수분을 이중 차감한다.
      // affected 큐: 경보 마킹 0행, WAIT 전환 0행.
      const service = buildService(
        { id: 5, orderId: 77, testDeliveryCount: 0 },
        { claimAffected: [1], confirmAffected: [0, 0] },
      );

      await expect(service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body())).rejects.toThrow(
        '테스트 발송 요청이 만료되었습니다. 다시 시도해주세요.',
      );

      expect(service.deliveryBatchService.oneSend).not.toHaveBeenCalled();
      // 이력은 멱등하게 정리하되(이미 지워진 행이라 0행), 한도는 건드리지 않는다.
      expect(rollbackDeletes(service).length).toBe(1);
      // 선점(+1) 외에 보상(-1) UPDATE 가 없어야 한다.
      expect(service.updateBuilder.captured.length).toBe(1);
      expect(service.logger.error).toHaveBeenCalled();
    });

    it('확정 UPDATE 가 실패하면 이력 삭제·한도 보상을 하지 않는다 (중복 발송 방지)', async () => {
      const service = buildService({ id: 5, orderId: 77, testDeliveryCount: 0 }, { claimAffected: [1] });
      // execute 순서: 진입부 정리(선점분 softDelete → 미선점분 softDelete) → 경보 마킹 → WAIT 전환 → 확정.
      // 위치 의존을 피하려고 마지막(확정) 호출만 실패시킨다.
      service.confirmBuilder.execute
        .mockResolvedValueOnce({ affected: 0 })
        .mockResolvedValueOnce({ affected: 0 })
        .mockResolvedValueOnce({ affected: 0 })
        .mockResolvedValueOnce({ affected: 1 })
        .mockRejectedValueOnce(new Error('confirm DB down'));

      await expect(service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body())).rejects.toThrow(
        'confirm DB down',
      );

      // 이미 발송된 건이므로 되돌리지 않는다. 선점(+1) 외에 보상(-1) UPDATE 가 없어야 한다.
      expect(rollbackDeletes(service).length).toBe(0);
      expect(service.updateBuilder.captured.length).toBe(1);
      expect(service.logger.error).toHaveBeenCalled();
    });

    it('확정 UPDATE 가 0행이어도 삭제·보상 없이 로그만 남긴다', async () => {
      // affected 큐: 경보 마킹 0행, WAIT 전환 1행, 확정 0행.
      const service = buildService(
        { id: 5, orderId: 77, testDeliveryCount: 0 },
        { claimAffected: [1], confirmAffected: [0, 1, 0] },
      );

      await expect(service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body())).resolves.toBeUndefined();

      expect(rollbackDeletes(service).length).toBe(0);
      expect(service.updateBuilder.captured.length).toBe(1);
      expect(service.logger.error).toHaveBeenCalled();
    });
  });
});
