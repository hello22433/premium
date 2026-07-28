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

/**
 * 테스트 발송(testDelivery) 정책 검증:
 *  - 운영관리자/최고관리자는 상품당 2회 제한을 우회한다 (횟수제한 예외로 막히지 않음).
 *  - 기업관리자(CORPORATE_ADMIN)는 상품당 2회 제한이 유지된다.
 *  - 한도 용량은 발송 전 조건부 UPDATE(test_delivery_count < 2) 로 원자 선점되어 동시 요청 초과가 차단된다.
 *  - 발송 실패 시 저장한 이력 정리 + 선점 한도 보상 차감(-1) 이 수행된다.
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
  const createMappingBuilder = (mapping: any) => {
    const builder: any = {
      innerJoinAndSelect: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn(() => Promise.resolve(mapping)),
    };
    return builder;
  };

  /**
   * 조건부 UPDATE(update().set().where().andWhere().execute()) 체인 mock.
   * execute() 는 affectedQueue 에서 순서대로 { affected } 를 반환한다.
   * 한도 선점(claim)과 보상 차감(rollback) 이 각각 이 체인을 쓴다.
   */
  const createUpdateBuilder = (affectedQueue: number[]) => {
    const captured: Array<{ set: any; where: string[] }> = [];
    let current: { set: any; where: string[] };
    const builder: any = {
      update: jest.fn(() => {
        current = { set: undefined, where: [] };
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
        const affected = affectedQueue.length > 0 ? affectedQueue.shift()! : 1;
        return Promise.resolve({ affected });
      }),
    };
    builder.captured = captured;
    return builder;
  };

  const buildService = (mapping: any, opts: { claimAffected?: number[] } = {}) => {
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
      createQueryBuilder: jest.fn((alias?: string) => (alias ? createMappingBuilder(fullMapping) : updateBuilder)),
      increment: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    service.updateBuilder = updateBuilder;

    service.logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() };
    service.orderDeliveryRepository = {
      findOne: jest.fn().mockResolvedValue(null),
    };
    service.testOrderDeliveryRepository = {
      save: jest.fn().mockResolvedValue({ id: 101 }),
      softDelete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
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

  it('운영관리자: 한도 조건부 UPDATE 없이 increment 로 무제한 발송된다 (우회)', async () => {
    const service = buildService({ id: 5, orderId: 77, testDeliveryCount: 99 });

    await expect(service.testDelivery(owner(IUserAuthority.OPERATION_ADMIN), body())).resolves.toBeUndefined();

    expect(service.deliveryBatchService.oneSend).toHaveBeenCalled();
    expect(service.orderProductMappingRepository.increment).toHaveBeenCalledWith({ id: 5 }, 'testDeliveryCount', 1);
    // 조건부 선점 UPDATE 는 호출되지 않는다.
    expect(service.updateBuilder.captured.length).toBe(0);
  });

  it('최고관리자: 한도 조건부 UPDATE 없이 increment 로 무제한 발송된다 (우회)', async () => {
    const service = buildService({ id: 5, orderId: 77, testDeliveryCount: 99 });

    await expect(service.testDelivery(owner(IUserAuthority.SUPER_ADMIN), body())).resolves.toBeUndefined();

    expect(service.deliveryBatchService.oneSend).toHaveBeenCalled();
    expect(service.orderProductMappingRepository.increment).toHaveBeenCalledWith({ id: 5 }, 'testDeliveryCount', 1);
    expect(service.updateBuilder.captured.length).toBe(0);
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

      expect(service.testOrderDeliveryRepository.softDelete).toHaveBeenCalledWith(101);
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

      expect(service.testOrderDeliveryRepository.softDelete).toHaveBeenCalledWith(101);
      expect(service.updateBuilder.captured[1]?.set.testDeliveryCount()).toContain('test_delivery_count - 1');
    });

    it('이력 삭제가 실패해도 한도 보상 차감은 수행된다(독립 try)', async () => {
      const service = buildService({ id: 5, orderId: 77, testDeliveryCount: 0 }, { claimAffected: [1] });
      service.deliveryBatchService.oneSend.mockResolvedValue(false);
      service.testOrderDeliveryRepository.softDelete.mockRejectedValue(new Error('DB down'));

      await expect(service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body())).rejects.toThrow(
        '테스트 발송에 실패했습니다. 수신자 정보를 확인해주세요.',
      );

      // 이력 삭제가 throw 해도 보상 차감(-1)은 실행되어야 한다.
      expect(service.updateBuilder.captured[1]?.set.testDeliveryCount()).toContain('test_delivery_count - 1');
      expect(service.logger.error).toHaveBeenCalled();
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
      expect(service.testOrderDeliveryRepository.softDelete).not.toHaveBeenCalled();
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
      expect(service.testOrderDeliveryRepository.softDelete).not.toHaveBeenCalled();
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
});
