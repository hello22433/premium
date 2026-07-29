import { BadRequestException } from '@nestjs/common';
import { OrderService } from './order.service';
import { IOrderStatus } from '../interface/order.status';

const user = { id: 10, email: 'user@test.com' } as any;

const createOrderQueryBuilder = (order: any) => {
  let filtersDeleted = false;
  let inScope = true;
  const queryBuilder: any = {
    innerJoinAndSelect: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    withDeleted: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn((clause: string, params?: Record<string, unknown>) => {
      if (clause === 'order.deletedAt IS NULL') {
        filtersDeleted = true;
      }
      if (clause.includes('order.userId = :userId')) {
        const userId = params?.userId;
        inScope =
          order?.userId === userId ||
          order?.operationUserId === userId ||
          (order?.clientUserId === userId && order?.apiAppId == null);
      }
      return queryBuilder;
    }),
    getOne: jest.fn(() =>
      Promise.resolve(order && inScope && (!filtersDeleted || order.deletedAt == null) ? order : null),
    ),
  };
  return queryBuilder;
};

const setupReportService = (order: any) => {
  const service = Object.create(OrderService.prototype) as any;
  const queryBuilder = createOrderQueryBuilder(order);
  service.orderRepository = {
    createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    save: jest.fn().mockResolvedValue(order),
  };
  service.userRepository = { findOne: jest.fn().mockResolvedValue({ id: user.id, companyId: 1, departmentId: 1 }) };
  service.userViewScopeRepository = { findOne: jest.fn().mockResolvedValue(null) };
  service.activityLogService = { createLog: jest.fn().mockResolvedValue(undefined) };
  service.mailSendSmtp = { send: jest.fn().mockResolvedValue({ success: true, messageId: 'mid', error: null }) };
  return { service, queryBuilder };
};

const emailBody = {
  orderId: 1,
  to: 'recipient@test.com',
  subject: '문서',
  content: '<p>문서</p>',
  pdfBase64: Buffer.from('pdf').toString('base64'),
  pdfFileName: 'report.pdf',
};

describe('OrderService support API guards', () => {
  it.each([
    ['deliveryCompleteReportPdf', (service: any) => service.deliveryCompleteReportPdf({ id: 1 }, user, '127.0.0.1')],
    ['orderCompleteReportPdf', (service: any) => service.orderCompleteReportPdf({ id: 1 }, user, '127.0.0.1')],
    [
      'sendDeliveryCompleteReportEmail',
      (service: any) => service.sendDeliveryCompleteReportEmail(emailBody, user, '127.0.0.1'),
    ],
    [
      'sendTransactionStatementReportEmail',
      (service: any) => service.sendTransactionStatementReportEmail(emailBody, user, '127.0.0.1'),
    ],
  ])('%s: 조회 범위 밖 주문은 카운터와 로그를 남기지 않는다', async (_name, call) => {
    const outOfScopeOrder = {
      id: 1,
      status: IOrderStatus.DELIVERY_COMPLETE,
      deletedAt: null,
      userId: 99,
      operationUserId: null,
      clientUserId: null,
      deliveryCompleteReportCount: 0,
      orderCompleteReportCount: 0,
    };
    const { service, queryBuilder } = setupReportService(outOfScopeOrder);

    await expect(call(service)).rejects.toBeInstanceOf(BadRequestException);
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('order.deletedAt IS NULL');
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      '(order.userId = :userId OR order.operationUserId = :userId OR (order.clientUserId = :userId AND order.apiAppId IS NULL))',
      { userId: user.id },
    );
    expect(service.orderRepository.save).not.toHaveBeenCalled();
    expect(service.mailSendSmtp.send).not.toHaveBeenCalled();
    expect(service.activityLogService.createLog).not.toHaveBeenCalled();
  });

  it.each([
    ['deliveryCompleteReportPdf', (service: any) => service.deliveryCompleteReportPdf({ id: 1 }, user, '127.0.0.1')],
    ['orderCompleteReportPdf', (service: any) => service.orderCompleteReportPdf({ id: 1 }, user, '127.0.0.1')],
    [
      'sendDeliveryCompleteReportEmail',
      (service: any) => service.sendDeliveryCompleteReportEmail(emailBody, user, '127.0.0.1'),
    ],
    [
      'sendTransactionStatementReportEmail',
      (service: any) => service.sendTransactionStatementReportEmail(emailBody, user, '127.0.0.1'),
    ],
  ])('%s: 발송 완료가 아닌 주문은 카운터와 로그를 남기지 않는다', async (_name, call) => {
    const order = {
      id: 1,
      status: IOrderStatus.DELIVERY_REQUEST,
      deletedAt: null,
      userId: user.id,
      operationUserId: null,
      clientUserId: null,
      deliveryCompleteReportCount: 0,
      orderCompleteReportCount: 0,
    };
    const { service } = setupReportService(order);

    await expect(call(service)).rejects.toBeInstanceOf(BadRequestException);
    expect(service.orderRepository.save).not.toHaveBeenCalled();
    expect(service.mailSendSmtp.send).not.toHaveBeenCalled();
    expect(service.activityLogService.createLog).not.toHaveBeenCalled();
  });

  it('문서 기록/메일 검증은 삭제된 주문을 거부한다', async () => {
    const deletedOrder = {
      id: 1,
      status: IOrderStatus.DELIVERY_COMPLETE,
      deletedAt: new Date(),
      userId: user.id,
      operationUserId: null,
      clientUserId: null,
      deliveryCompleteReportCount: 0,
    };
    const { service } = setupReportService(deletedOrder);

    await expect(service.deliveryCompleteReportPdf({ id: 1 }, user, '127.0.0.1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(service.orderRepository.save).not.toHaveBeenCalled();
    expect(service.activityLogService.createLog).not.toHaveBeenCalled();
  });

  it('문서 기록/메일 검증은 API 앱 주문의 clientUserId 일치만으로 조회 범위에 포함하지 않는다', async () => {
    const apiAppOrder = {
      id: 1,
      status: IOrderStatus.DELIVERY_COMPLETE,
      deletedAt: null,
      userId: 99,
      operationUserId: null,
      clientUserId: user.id,
      apiAppId: '123',
      deliveryCompleteReportCount: 0,
    };
    const { service } = setupReportService(apiAppOrder);

    await expect(service.deliveryCompleteReportPdf({ id: 1 }, user, '127.0.0.1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(service.orderRepository.save).not.toHaveBeenCalled();
    expect(service.activityLogService.createLog).not.toHaveBeenCalled();
  });

  it('getPreviousContent: 현재 주문 제외 조건은 주문 id 기준이다', async () => {
    const service = Object.create(OrderService.prototype) as any;
    const currentOrderQueryBuilder = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue({ id: 100, type: 'GENERAL' }),
    };
    const queryBuilder = {
      innerJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
    };
    service.orderRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(currentOrderQueryBuilder),
    };
    service.orderProductMappingRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };
    service.userRepository = { findOne: jest.fn().mockResolvedValue({ id: user.id, companyId: 1, departmentId: 1 }) };
    service.userViewScopeRepository = { findOne: jest.fn().mockResolvedValue(null) };

    await service.getPreviousContent(user, { orderId: 100 });

    expect(currentOrderQueryBuilder.andWhere).toHaveBeenCalledWith(
      '(order.userId = :userId OR order.operationUserId = :userId OR (order.clientUserId = :userId AND order.apiAppId IS NULL))',
      { userId: user.id },
    );
    expect(queryBuilder.where).toHaveBeenCalledWith('order.id != :id', { id: 100 });
  });

  it('getPreviousContent: 현재 주문이 조회 범위 밖이면 이전 문구를 조회하지 않고 빈 응답을 반환한다', async () => {
    const service = Object.create(OrderService.prototype) as any;
    const currentOrderQueryBuilder = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
    };
    service.orderRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(currentOrderQueryBuilder),
    };
    service.orderProductMappingRepository = {
      createQueryBuilder: jest.fn(),
    };
    service.userRepository = { findOne: jest.fn().mockResolvedValue({ id: user.id, companyId: 1, departmentId: 1 }) };
    service.userViewScopeRepository = { findOne: jest.fn().mockResolvedValue(null) };

    await expect(service.getPreviousContent(user, { orderId: 100 })).resolves.toEqual({
      sendTitle: null,
      sendContent: null,
    });
    expect(service.orderProductMappingRepository.createQueryBuilder).not.toHaveBeenCalled();
  });
});
