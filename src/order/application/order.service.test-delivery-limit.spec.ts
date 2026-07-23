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
import { IUserAuthority } from '../../user/interface/user.authority';
import { ViewScopeType } from '../../entity/user.view.scope.entity';

/**
 * 테스트 발송(testDelivery) 정책 검증:
 *  - 운영관리자/최고관리자는 상품당 2회 제한을 우회한다 (횟수제한 예외로 막히지 않음).
 *  - 기업관리자(CORPORATE_ADMIN)는 상품당 2회 제한이 유지된다.
 *  - orderId 와 orderProductMapping.orderId 불일치(IDOR) 는 거부된다.
 *  - assertOrderInViewScope 로 조회 범위 밖 주문은 거부된다.
 *
 * 실제 DB 없이 mock repository 로 앞단 가드(스코프/불일치/횟수제한)만 평가한다.
 * 가드 통과 케이스는 이후 무거운 발송 경로(이미지 생성 등)에서 별도 이유로 실패하므로,
 * "횟수제한 예외 메시지로는 막히지 않음" 을 확인하는 방식으로 우회를 검증한다.
 */
describe('OrderService testDelivery 정책 (횟수제한/IDOR)', () => {
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
      setLock: jest.fn().mockReturnThis(),
      getOne: jest.fn(() => Promise.resolve(mapping)),
    };
    return builder;
  };

  const buildService = (mapping: any) => {
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
      order: { id: 77, type: 'GENERAL', user: { fromPhoneNumber: '0212345678' } },
      ...mapping,
    };
    const service = Object.create(OrderService.prototype) as any;
    service.orderRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(createScopeBuilder()),
    };
    service.orderProductMappingRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(createMappingBuilder(fullMapping)),
      save: jest.fn().mockResolvedValue(fullMapping),
      increment: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    service.logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() };
    service.orderDeliveryRepository = {
      findOne: jest.fn().mockResolvedValue(null),
    };
    service.testOrderDeliveryRepository = {
      save: jest.fn().mockResolvedValue({ id: 101 }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
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

  it('기업관리자: testDeliveryCount 가 2 이상이면 횟수제한으로 거부된다', async () => {
    const service = buildService({ id: 5, orderId: 77, testDeliveryCount: 2 });
    await expect(service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body())).rejects.toThrow(LIMIT_MSG);
  });

  it('동시 테스트 발송 제한을 위해 orderProductMapping row 에 pessimistic_write 락을 건다', async () => {
    const mappingBuilder = createMappingBuilder({ id: 5, orderId: 77, testDeliveryCount: 2 });
    const service = buildService({ id: 5, orderId: 77, testDeliveryCount: 2 });
    service.orderProductMappingRepository.createQueryBuilder.mockReturnValueOnce(mappingBuilder);

    await expect(service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body())).rejects.toThrow(LIMIT_MSG);

    expect(mappingBuilder.setLock).toHaveBeenCalledWith('pessimistic_write');
  });

  it('운영관리자: testDeliveryCount 가 2 이상이어도 횟수제한 예외로는 막히지 않는다 (우회)', async () => {
    const service = buildService({ id: 5, orderId: 77, testDeliveryCount: 99 });

    await expect(service.testDelivery(owner(IUserAuthority.OPERATION_ADMIN), body())).resolves.toBeUndefined();

    expect(service.deliveryBatchService.oneSend).toHaveBeenCalled();
    expect(service.testOrderDeliveryRepository.update).toHaveBeenCalledWith(101, { status: 'COMPLETE' });
    expect(service.orderProductMappingRepository.increment).toHaveBeenCalledWith({ id: 5 }, 'testDeliveryCount', 1);
  });

  it('최고관리자: testDeliveryCount 가 2 이상이어도 횟수제한 예외로는 막히지 않는다 (우회)', async () => {
    const service = buildService({ id: 5, orderId: 77, testDeliveryCount: 99 });

    await expect(service.testDelivery(owner(IUserAuthority.SUPER_ADMIN), body())).resolves.toBeUndefined();

    expect(service.deliveryBatchService.oneSend).toHaveBeenCalled();
    expect(service.testOrderDeliveryRepository.update).toHaveBeenCalledWith(101, { status: 'COMPLETE' });
    expect(service.orderProductMappingRepository.increment).toHaveBeenCalledWith({ id: 5 }, 'testDeliveryCount', 1);
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

  // 발송이 트랜잭션 밖에서 수행되는지, 실패 시 예약 이력이 정리되는지 검증
  describe('발송 실패 경로', () => {
    it('oneSend 가 false 를 반환하면 실패 예외를 던지고 이력 삭제 + 횟수는 증가하지 않는다', async () => {
      const service = buildService({ id: 5, orderId: 77, testDeliveryCount: 0 });
      service.deliveryBatchService.oneSend.mockResolvedValue(false);

      await expect(service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body())).rejects.toThrow(
        '테스트 발송에 실패했습니다. 수신자 정보를 확인해주세요.',
      );

      // 발송 실패 시 횟수는 소모되지 않는다 (기존 동작과 동일).
      expect(service.orderProductMappingRepository.increment).not.toHaveBeenCalled();
      // 실패 건은 이력에 남지 않도록 soft delete 되고, COMPLETE 로 확정되지 않아야 한다.
      expect(service.testOrderDeliveryRepository.softDelete).toHaveBeenCalledWith(101);
      expect(service.testOrderDeliveryRepository.update).not.toHaveBeenCalledWith(101, { status: 'COMPLETE' });
    });

    it('oneSend 가 예외를 던져도 이력 삭제 후 원 예외를 전파한다', async () => {
      const service = buildService({ id: 5, orderId: 77, testDeliveryCount: 0 });
      const providerError = new Error('provider timeout');
      service.deliveryBatchService.oneSend.mockRejectedValue(providerError);

      await expect(service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body())).rejects.toThrow(
        'provider timeout',
      );

      expect(service.orderProductMappingRepository.increment).not.toHaveBeenCalled();
      expect(service.testOrderDeliveryRepository.softDelete).toHaveBeenCalledWith(101);
      expect(service.testOrderDeliveryRepository.update).not.toHaveBeenCalledWith(101, { status: 'COMPLETE' });
    });

    it('이력 제거가 실패해도 원 발송 실패 사유를 덮지 않는다', async () => {
      const service = buildService({ id: 5, orderId: 77, testDeliveryCount: 0 });
      service.deliveryBatchService.oneSend.mockResolvedValue(false);
      service.testOrderDeliveryRepository.softDelete.mockRejectedValue(new Error('DB down'));

      await expect(service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body())).rejects.toThrow(
        '테스트 발송에 실패했습니다. 수신자 정보를 확인해주세요.',
      );

      expect(service.logger.error).toHaveBeenCalled();
    });

    it('횟수 증가(increment)는 발송(oneSend) 이후에 일어난다 — 발송 성공 건만 소모', async () => {
      const callOrder: string[] = [];
      const service = buildService({ id: 5, orderId: 77, testDeliveryCount: 0 });
      service.orderProductMappingRepository.increment.mockImplementation(() => {
        callOrder.push('increment');
        return Promise.resolve({ affected: 1 });
      });
      service.deliveryBatchService.oneSend.mockImplementation(() => {
        callOrder.push('oneSend');
        return Promise.resolve(true);
      });

      await expect(service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body())).resolves.toBeUndefined();

      expect(callOrder).toEqual(['oneSend', 'increment']);
    });

    it('WAIT 로 저장한 뒤 발송하고, 성공 시에만 COMPLETE 로 확정한다', async () => {
      const service = buildService({ id: 5, orderId: 77, testDeliveryCount: 0 });

      await expect(service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body())).resolves.toBeUndefined();

      // 예약 단계에서는 WAIT 로 저장된다.
      expect(service.testOrderDeliveryRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'WAIT' }),
      );
      expect(service.testOrderDeliveryRepository.update).toHaveBeenCalledWith(101, { status: 'COMPLETE' });
      expect(service.testOrderDeliveryRepository.softDelete).not.toHaveBeenCalled();
    });

    it('mapping 이 없으면 발송 시도 없이 거부된다', async () => {
      const service = buildService({ id: 5, orderId: 77, testDeliveryCount: 0 });
      service.orderProductMappingRepository.createQueryBuilder.mockReturnValue(createMappingBuilder(null));

      await expect(service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body())).rejects.toThrow(
        '해당 주문-상품이 존재하지 않습니다.',
      );

      expect(service.deliveryBatchService.oneSend).not.toHaveBeenCalled();
      expect(service.orderProductMappingRepository.increment).not.toHaveBeenCalled();
    });

    it('가드(IDOR/횟수제한) 위반 시 발송도 횟수 증가도 일어나지 않는다', async () => {
      const service = buildService({ id: 5, orderId: 88, testDeliveryCount: 0 });

      await expect(service.testDelivery(owner(IUserAuthority.CORPORATE_ADMIN), body())).rejects.toThrow(MISMATCH_MSG);

      expect(service.deliveryBatchService.oneSend).not.toHaveBeenCalled();
      expect(service.orderProductMappingRepository.increment).not.toHaveBeenCalled();
      expect(service.testOrderDeliveryRepository.save).not.toHaveBeenCalled();
    });
  });
});
