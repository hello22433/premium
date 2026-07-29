import { BadRequestException } from '@nestjs/common';
import { OrderService } from './order.service';
import { IUserAuthority } from '../../user/interface/user.authority';
import { IOrderStatus } from '../interface/order.status';
import { ViewScopeType } from '../../entity/user.view.scope.entity';

describe('OrderService mapping scope', () => {
  const outOfScopeUser = { id: 999, email: 'x@x.com', authority: IUserAuthority.CORPORATE_ADMIN };
  const inScopeUser = { id: 10, email: 'o@x.com', authority: IUserAuthority.CORPORATE_ADMIN };

  const baseMapping = {
    id: 77,
    encourageDay: null,
    galaxiaDuration: null,
    sendTailText: null,
    useEmailContent: null,
    order: {
      id: 1,
      status: IOrderStatus.DELIVERY_REQUEST,
      userId: 10,
      operationUserId: null,
      clientUserId: null,
    },
    product: {
      name: 'GALAXIA 쿠폰',
      partnerCompany: { type: 'GALAXIA' },
    },
  } as any;

  const createScopeAwareMappingBuilder = (mapping: typeof baseMapping) => {
    let inScope = true;
    let directSendingAllowed = true;
    const builder: any = {
      innerJoinAndSelect: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn((clause: string, params: Record<string, unknown>) => {
        if (clause.includes('order.userId = :userId')) {
          const uid = params.userId;
          const order = mapping.order;
          inScope = order.userId === uid || order.operationUserId === uid || order.clientUserId === uid;
        }
        if (clause.includes('user.companyId = :companyId')) {
          inScope = true;
        }
        if (clause.includes('order.clientUserId IS NULL OR order.operationUserId = :currentUserId')) {
          const currentUserId = params.currentUserId;
          const order = mapping.order;
          directSendingAllowed = order.clientUserId === null || order.operationUserId === currentUserId;
        }
        return builder;
      }),
      getOne: jest.fn(() => Promise.resolve(inScope && directSendingAllowed ? mapping : null)),
    };
    return builder;
  };

  const buildService = (mapping: typeof baseMapping, scopeType = ViewScopeType.SELF) => {
    const service = Object.create(OrderService.prototype) as any;
    const builder = createScopeAwareMappingBuilder(mapping);
    service.orderProductMappingRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(builder),
      findOne: jest.fn().mockResolvedValue(mapping),
      save: jest.fn().mockResolvedValue(mapping),
    };
    service.orderDeliveryRepository = {
      createQueryBuilder: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      }),
    };
    service.userRepository = {
      findOne: jest.fn().mockResolvedValue({ id: undefined, companyId: 100, departmentId: 5 }),
    };
    service.userViewScopeRepository = {
      findOne: jest.fn().mockResolvedValue({ scopeType, getDeptIdList: () => [] }),
    };
    return service;
  };

  it.each([
    ['updateEncourageDay', (service: any) => service.updateEncourageDay(outOfScopeUser, 77, { encourageDay: 1 })],
    [
      'updateGalaxiaDuration',
      (service: any) => service.updateGalaxiaDuration(outOfScopeUser, 77, { galaxiaDuration: 30 }),
    ],
    ['updateTailText', (service: any) => service.updateTailText(outOfScopeUser, 77, { sendTailText: 'tail' })],
    [
      'updateUseEmailContent',
      (service: any) => service.updateUseEmailContent(outOfScopeUser, 77, { useEmailContent: 'guide' }),
    ],
  ])('%s: 범위 밖 사용자는 매핑 설정을 수정할 수 없다', async (_name, call) => {
    const service = buildService({ ...baseMapping, order: { ...baseMapping.order } });

    await expect(call(service)).rejects.toBeInstanceOf(BadRequestException);
    expect(service.orderProductMappingRepository.save).not.toHaveBeenCalled();
  });

  it('범위 안 사용자는 기존 검증을 통과하면 매핑 설정을 저장한다', async () => {
    const service = buildService({ ...baseMapping, order: { ...baseMapping.order } });

    await service.updateGalaxiaDuration(inScopeUser, 77, { galaxiaDuration: 30 });

    expect(service.orderProductMappingRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ galaxiaDuration: 30 }),
    );
  });

  it.each([
    ['음수', -1],
    ['소수', 1.5],
  ])('updateEncourageDay: %s 독려일은 저장하지 않는다', async (_name, encourageDay) => {
    const service = buildService({ ...baseMapping, order: { ...baseMapping.order } });

    await expect(service.updateEncourageDay(inScopeUser, 77, { encourageDay })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(service.orderProductMappingRepository.save).not.toHaveBeenCalled();
  });

  it('updateEncourageDay: encourageDay 누락은 저장 없이 no-op 처리한다', async () => {
    const service = buildService({ ...baseMapping, order: { ...baseMapping.order } });

    await service.updateEncourageDay(inScopeUser, 77, {} as any);

    expect(service.orderProductMappingRepository.save).not.toHaveBeenCalled();
  });

  it('회사 범위 운영관리자는 다른 운영관리자 담당 대행발송 매핑을 수정할 수 없다', async () => {
    const operationAdmin = { id: 10, email: 'op@x.com', authority: IUserAuthority.OPERATION_ADMIN };
    const service = buildService(
      {
        ...baseMapping,
        order: {
          ...baseMapping.order,
          userId: 30,
          operationUserId: 20,
          clientUserId: 40,
        },
      },
      ViewScopeType.COMPANY,
    );

    await expect(service.updateEncourageDay(operationAdmin, 77, { encourageDay: 1 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(service.orderProductMappingRepository.save).not.toHaveBeenCalled();
  });
});
