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

const makeDelivery = (
  deliveryTarget: string,
  deletedAt: Date | null = null,
  overrides: Partial<{ status: IOrderDeliveryStatus; refundStatus: any }> = {},
) => ({
  deliveryTarget,
  deletedAt,
  status: overrides.status ?? IOrderDeliveryStatus.COMPLETE,
  refundStatus: overrides.refundStatus ?? null,
});

const makeOrder = (deliveries: ReturnType<typeof makeDelivery>[], status = IOrderStatus.DELIVERY_COMPLETE) => ({
  id: 1,
  status,
  orderProductMappings: [{ id: 1, orderDeliveries: deliveries }],
});

const setupService = (order: any) => {
  const service = Object.create(OrderService.prototype) as any;
  service.orderRepository = { findOne: jest.fn().mockResolvedValue(order) };
  service.mailSendSmtp = { send: jest.fn().mockResolvedValue({ success: true, messageId: 'mid', error: null }) };
  service.activityLogService = { createLog: jest.fn().mockResolvedValue(undefined) };
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
    ).rejects.toBeInstanceOf(BadRequestException);
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

    // 첫 호출 = 게이트 조회(withDeleted). (이후 sendReportEmail 이 존재확인용으로 한 번 더 조회한다)
    const findOneArg = service.orderRepository.findOne.mock.calls[0][0];
    expect(findOneArg.withDeleted).toBe(true);
    expect(findOneArg.relations).toEqual(expect.arrayContaining(['orderProductMappings.orderDeliveries']));
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

    await expect(service.destructionCertificatePdf({ id: 1 } as any, BASE_USER, '127.0.0.1')).rejects.toBeInstanceOf(
      BadRequestException,
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

    const findOneArg = service.orderRepository.findOne.mock.calls[0][0];
    expect(findOneArg.withDeleted).toBe(true);
    expect(findOneArg.relations).toEqual(expect.arrayContaining(['orderProductMappings.orderDeliveries']));
  });
});
