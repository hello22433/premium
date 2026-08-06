import { BadRequestException } from '@nestjs/common';
import { OrderService } from './order.service';
import { IOrderStatus } from '../interface/order.status';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { OrderDeliveryRefundStatusEnum } from '../../delivery/interface/order.delivery.refund.status.enum';

const BASE_USER = {
  id: 1,
  email: 'admin@test.com',
} as any;

const makeEmailBody = () =>
  ({
    orderId: 1,
    to: 'client@test.com',
    subject: '파기확인서',
    content: '<p>파기확인서</p>',
    pdfBase64: Buffer.from('pdf').toString('base64'),
    pdfFileName: 'destruction.pdf',
  }) as any;

/**
 * 파기된 발송건은 **파기 시각 각인까지** 있는 정상 상태로 만든다.
 * 게이트가 파기일 축을 교차 검증하므로(리뷰 3차 H-1), 각인이 없으면 DESTROY_TIME_UNKNOWN 으로
 * 막혀 이 스펙의 검증 의도(전량 파기면 메일 발송)가 사라진다.
 */
const makeDelivery = (
  deliveryTarget: string,
  deletedAt: Date | null = null,
  overrides: Partial<{ status: IOrderDeliveryStatus; refundStatus: any }> = {},
) => {
  const destroyed = deliveryTarget === '-';
  return {
    deliveryTarget,
    emailReceiverPhone: destroyed ? '-' : null,
    expireAt: null,
    destroyedAt: destroyed ? new Date('2026-02-01T09:30:00') : null,
    destroyedAtSource: destroyed ? 'BATCH' : null,
    deletedAt,
    status: overrides.status ?? IOrderDeliveryStatus.COMPLETE,
    refundStatus: overrides.refundStatus ?? null,
  };
};

const makeOrder = (deliveries: ReturnType<typeof makeDelivery>[], status = IOrderStatus.DELIVERY_COMPLETE) => ({
  id: 1,
  status,
  orderProductMappings: [
    {
      id: 1,
      orderDeliveries: deliveries,
      sendRequestAt: new Date('2026-01-01T14:00:00'),
      requestToDestroyPersonalInfoDay: 180,
    },
  ],
});

const setupService = (order: any) => {
  const service = Object.create(OrderService.prototype) as any;
  const queryBuilder = {
    innerJoinAndSelect: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    withDeleted: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(order),
  };
  service.orderRepository = {
    findOne: jest.fn().mockResolvedValue(order),
    createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
  };
  service.userRepository = {
    findOne: jest.fn().mockResolvedValue({ id: BASE_USER.id, companyId: 1, departmentId: 1 }),
  };
  service.userViewScopeRepository = { findOne: jest.fn().mockResolvedValue(null) };
  service.mailSendSmtp = { send: jest.fn().mockResolvedValue({ success: true, messageId: 'mid', error: null }) };
  service.activityLogService = { createLog: jest.fn().mockResolvedValue(undefined) };
  service.__queryBuilder = queryBuilder;
  return service;
};

describe('OrderService sendDestructionCertificateReportEmail — 발행 게이트', () => {
  it('전량 파기 완료(모든 deliveryTarget = "-")면 메일을 발송한다', async () => {
    const service = setupService(makeOrder([makeDelivery('-'), makeDelivery('-')]));

    const result = await service.sendDestructionCertificateReportEmail(makeEmailBody(), BASE_USER, '127.0.0.1');

    expect(result.success).toBe(true);
    expect(service.mailSendSmtp.send).toHaveBeenCalledTimes(1);
  });

  it('미파기 배송건이 있으면 BadRequestException 을 던지고 메일을 발송하지 않는다', async () => {
    const service = setupService(makeOrder([makeDelivery('-'), makeDelivery('enc-01012341234')]));

    await expect(
      service.sendDestructionCertificateReportEmail(makeEmailBody(), BASE_USER, '127.0.0.1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(service.mailSendSmtp.send).not.toHaveBeenCalled();
  });

  it('환불 진행 중 배송건이 포함되면 BadRequestException 을 던지고 메일을 발송하지 않는다', async () => {
    const service = setupService(
      makeOrder([
        makeDelivery('-'),
        makeDelivery('enc-01012341234', null, { refundStatus: OrderDeliveryRefundStatusEnum.PROGRESS }),
      ]),
    );

    await expect(
      service.sendDestructionCertificateReportEmail(makeEmailBody(), BASE_USER, '127.0.0.1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(service.mailSendSmtp.send).not.toHaveBeenCalled();
  });

  it('발송 완료 상태가 아니면 BadRequestException 을 던진다', async () => {
    const service = setupService(makeOrder([makeDelivery('-')], IOrderStatus.DELIVERY_REQUEST));

    await expect(
      service.sendDestructionCertificateReportEmail(makeEmailBody(), BASE_USER, '127.0.0.1'),
    ).rejects.toThrow('발송 완료된 건에 대해서만 발행 가능합니다.');
    expect(service.mailSendSmtp.send).not.toHaveBeenCalled();
  });

  it('soft-delete 배송건에만 미파기 수신처가 남아 있어도 차단한다', async () => {
    const service = setupService(makeOrder([makeDelivery('-'), makeDelivery('enc-01012341234', new Date())]));

    await expect(
      service.sendDestructionCertificateReportEmail(makeEmailBody(), BASE_USER, '127.0.0.1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(service.mailSendSmtp.send).not.toHaveBeenCalled();
  });

  it('soft-delete 배송건도 파기 완료면 발송한다', async () => {
    const service = setupService(makeOrder([makeDelivery('-'), makeDelivery('-', new Date())]));

    const result = await service.sendDestructionCertificateReportEmail(makeEmailBody(), BASE_USER, '127.0.0.1');

    expect(result.success).toBe(true);
    expect(service.mailSendSmtp.send).toHaveBeenCalledTimes(1);
  });

  it('게이트 조회는 soft-delete 배송건까지 포함한다 (withDeleted)', async () => {
    const service = setupService(makeOrder([makeDelivery('-')]));

    await service.sendDestructionCertificateReportEmail(makeEmailBody(), BASE_USER, '127.0.0.1');

    expect(service.__queryBuilder.withDeleted).toHaveBeenCalled();
    expect(service.__queryBuilder.andWhere).toHaveBeenCalledWith('order.deletedAt IS NULL');
    expect(service.__queryBuilder.leftJoinAndSelect).toHaveBeenCalledWith(
      'orderProductMappings.orderDeliveries',
      'orderDeliveries',
    );
  });
});

describe('OrderService destructionCertificatePdf — 발행 게이트', () => {
  it('전량 파기 완료면 로그를 기록한다', async () => {
    const service = setupService(makeOrder([makeDelivery('-'), makeDelivery('-')]));

    await service.destructionCertificatePdf({ id: 1 } as any, BASE_USER, '127.0.0.1');

    expect(service.activityLogService.createLog).toHaveBeenCalledTimes(1);
  });

  it('미파기 배송건이 있으면 BadRequestException 을 던지고 로그를 기록하지 않는다', async () => {
    const service = setupService(makeOrder([makeDelivery('-'), makeDelivery('enc-01012341234')]));

    await expect(service.destructionCertificatePdf({ id: 1 } as any, BASE_USER, '127.0.0.1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(service.activityLogService.createLog).not.toHaveBeenCalled();
  });

  it('환불 진행 중 배송건이 포함되면 BadRequestException 을 던진다', async () => {
    const service = setupService(
      makeOrder([
        makeDelivery('-'),
        makeDelivery('enc-01012341234', null, { refundStatus: OrderDeliveryRefundStatusEnum.PROGRESS }),
      ]),
    );

    await expect(service.destructionCertificatePdf({ id: 1 } as any, BASE_USER, '127.0.0.1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(service.activityLogService.createLog).not.toHaveBeenCalled();
  });

  it('발송 완료 상태가 아니면 BadRequestException 을 던진다', async () => {
    const service = setupService(makeOrder([makeDelivery('-')], IOrderStatus.DELIVERY_REQUEST));

    await expect(service.destructionCertificatePdf({ id: 1 } as any, BASE_USER, '127.0.0.1')).rejects.toThrow(
      '발송 완료된 건에 대해서만 발행 가능합니다.',
    );
    expect(service.activityLogService.createLog).not.toHaveBeenCalled();
  });

  it('soft-delete 배송건에만 미파기 수신처가 남아 있어도 차단한다', async () => {
    const service = setupService(makeOrder([makeDelivery('-'), makeDelivery('enc-01012341234', new Date())]));

    await expect(service.destructionCertificatePdf({ id: 1 } as any, BASE_USER, '127.0.0.1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(service.activityLogService.createLog).not.toHaveBeenCalled();
  });

  it('soft-delete 배송건도 파기 완료면 로그를 기록한다', async () => {
    const service = setupService(makeOrder([makeDelivery('-'), makeDelivery('-', new Date())]));

    await service.destructionCertificatePdf({ id: 1 } as any, BASE_USER, '127.0.0.1');

    expect(service.activityLogService.createLog).toHaveBeenCalledTimes(1);
  });

  it('게이트 조회는 soft-delete 배송건까지 포함한다 (withDeleted)', async () => {
    const service = setupService(makeOrder([makeDelivery('-')]));

    await service.destructionCertificatePdf({ id: 1 } as any, BASE_USER, '127.0.0.1');

    expect(service.__queryBuilder.withDeleted).toHaveBeenCalled();
    expect(service.__queryBuilder.andWhere).toHaveBeenCalledWith('order.deletedAt IS NULL');
    expect(service.__queryBuilder.leftJoinAndSelect).toHaveBeenCalledWith(
      'orderProductMappings.orderDeliveries',
      'orderDeliveries',
    );
  });
});
