import { CustomerServiceService } from '../../customer_service/application/customer.service.service';
import { DeliveryCancelIntentEntity } from '../../entity/delivery.cancel.intent.entity';
import { ExternalApiService } from '../../external_api/application/external.api.service';
import { OrderDeliveryCouponStatus } from '../interface/order.delivery.coupon.status';
import { RefundAttemptStatus } from '../interface/refund.attempt.status';
import { DeliveryCancelIntentSource, DeliveryCancelIntentStatus } from '../interface/delivery.cancel.intent.status';

describe('delivery cancel intent reconciliation', () => {
  const slot = {
    orderDeliveryId: 77,
    op: 'DISCARD',
    ownerToken: 'reconcile-owner',
    workflowVersion: '9',
  } as any;

  const intent = (overrides: Partial<DeliveryCancelIntentEntity> = {}) =>
    ({
      id: '31',
      orderDeliveryId: 77,
      source: DeliveryCancelIntentSource.EXTERNAL_API,
      status: DeliveryCancelIntentStatus.PENDING,
      reconcileFromStatus: null,
      requestedCouponStatus: OrderDeliveryCouponStatus.CANCEL,
      refundRequired: true,
      requestedByUserId: 9,
      refundAttemptId: null,
      expectedRefundAmount: 1000,
      expectedRefundScope: 'FULL',
      ...overrides,
    }) as DeliveryCancelIntentEntity;

  it('PENDING external intent confirms partner cancellation and resumes DB application', async () => {
    const sut: any = Object.create(ExternalApiService.prototype);
    const candidate = intent();
    const orderDelivery = {
      id: 77,
      barCode: 'PIN-1',
      couponStatus: OrderDeliveryCouponStatus.NOT_USED,
      orderProductMapping: {
        order: { id: 10, userId: 9, clientUserId: null, settleAmount: 1000 },
        product: { partnerCompany: { id: 1 } },
      },
    };
    sut.deliveryWorkflowSlotService = {
      acquire: jest.fn().mockResolvedValue({ acquired: true, slot }),
      release: jest.fn().mockResolvedValue(true),
    };
    sut.deliveryCancelIntentService = {
      claimForReconcile: jest.fn().mockResolvedValue(candidate),
      effectiveStatus: jest.fn().mockReturnValue(DeliveryCancelIntentStatus.PENDING),
      markExternalCancelled: jest.fn().mockResolvedValue(undefined),
    };
    sut.orderDeliveryRepository = { findOne: jest.fn().mockResolvedValue(orderDelivery) };
    sut.userRepository = {
      findOne: jest.fn().mockResolvedValue({ id: 9, email: 'billing@example.com' }),
    };
    sut.partnerCompanyExternService = {
      refreshCouponStatus: jest
        .fn()
        .mockResolvedValue({ ...orderDelivery, couponStatus: OrderDeliveryCouponStatus.NOT_USED }),
      cancelByExternalApi: jest.fn().mockResolvedValue(undefined),
    };
    sut.processCutoverCancelRefund = jest.fn().mockResolvedValue(undefined);

    await sut.reconcileCancelIntent(candidate);

    expect(sut.partnerCompanyExternService.refreshCouponStatus).toHaveBeenCalledWith(orderDelivery);
    expect(sut.partnerCompanyExternService.cancelByExternalApi).toHaveBeenCalledWith(orderDelivery);
    expect(sut.deliveryCancelIntentService.markExternalCancelled).toHaveBeenCalledWith('31', slot);
    expect(sut.processCutoverCancelRefund).toHaveBeenCalledWith(
      orderDelivery.orderProductMapping.order,
      orderDelivery,
      expect.objectContaining({ user: expect.objectContaining({ id: 9 }) }),
      slot,
      '31',
    );
  });

  it('DB_APPLIED external intent closes from an existing successful refund attempt', async () => {
    const sut: any = Object.create(ExternalApiService.prototype);
    const candidate = intent({
      status: DeliveryCancelIntentStatus.DB_APPLIED,
      refundAttemptId: 'attempt-1',
    });
    const orderDelivery = {
      id: 77,
      orderProductMapping: {
        order: { id: 10, userId: 9, clientUserId: null, settleAmount: 1000 },
        product: {},
      },
    };
    sut.deliveryWorkflowSlotService = {
      acquire: jest.fn().mockResolvedValue({ acquired: true, slot }),
      release: jest.fn().mockResolvedValue(true),
    };
    sut.deliveryCancelIntentService = {
      claimForReconcile: jest.fn().mockResolvedValue(candidate),
      effectiveStatus: jest.fn().mockReturnValue(DeliveryCancelIntentStatus.DB_APPLIED),
      markRefundSucceeded: jest.fn().mockResolvedValue(undefined),
      getRequired: jest.fn().mockResolvedValue(candidate),
    };
    sut.orderDeliveryRepository = { findOne: jest.fn().mockResolvedValue(orderDelivery) };
    sut.userRepository = {
      findOne: jest.fn().mockResolvedValue({ id: 9, email: 'billing@example.com' }),
    };
    sut.refundAttemptExecutor = {
      findBoundAttempt: jest.fn().mockResolvedValue({
        id: 'attempt-1',
        status: RefundAttemptStatus.SUCCEEDED,
      }),
    };

    await sut.reconcileCancelIntent(candidate);

    expect(sut.deliveryWorkflowSlotService.release).toHaveBeenCalledWith(slot);
    expect(sut.deliveryCancelIntentService.markRefundSucceeded).toHaveBeenCalledWith('31', {
      attemptId: 'attempt-1',
      orderDeliveryId: 77,
      amount: 1000,
      scope: 'FULL',
    });
  });

  it('PENDING CS intent retries an active partner cancellation before DB application', async () => {
    const sut: any = Object.create(CustomerServiceService.prototype);
    const candidate = intent({
      source: DeliveryCancelIntentSource.CUSTOMER_SERVICE,
      status: DeliveryCancelIntentStatus.PENDING,
      refundRequired: false,
    });
    const orderDelivery = {
      id: 77,
      couponStatus: OrderDeliveryCouponStatus.NOT_USED,
      discardedAt: null,
      orderProductMapping: { order: {}, product: {} },
    };
    const workflowBuilder: any = {};
    for (const method of ['update', 'set', 'where', 'andWhere']) {
      workflowBuilder[method] = jest.fn(() => workflowBuilder);
    }
    workflowBuilder.execute = jest.fn().mockResolvedValue({ affected: 1 });
    const manager = {
      getRepository: jest.fn((entity: any) =>
        entity.name.includes('Workflow')
          ? { createQueryBuilder: jest.fn(() => workflowBuilder) }
          : { update: jest.fn().mockResolvedValue({ affected: 1 }) },
      ),
    };
    sut.dataSource = {
      transaction: jest.fn(async (callback: (manager: any) => unknown) => callback(manager)),
    };
    sut.deliveryWorkflowSlotService = {
      acquire: jest.fn().mockResolvedValue({ acquired: true, slot }),
      release: jest.fn().mockResolvedValue(true),
    };
    sut.deliveryCancelIntentService = {
      claimForReconcile: jest.fn().mockResolvedValue(candidate),
      effectiveStatus: jest.fn().mockReturnValue(DeliveryCancelIntentStatus.PENDING),
      markExternalCancelled: jest.fn().mockResolvedValue(undefined),
      markDbApplied: jest.fn().mockResolvedValue(undefined),
      markResolvedNoRefund: jest.fn().mockResolvedValue(undefined),
    };
    sut.orderDeliveryRepository = { findOne: jest.fn().mockResolvedValue(orderDelivery) };
    sut.getPartnerType = jest.fn().mockReturnValue('GIFT_SHOW');
    sut.partnerCompanyExternService = {
      refreshCouponStatus: jest.fn().mockResolvedValue({
        ...orderDelivery,
        couponStatus: OrderDeliveryCouponStatus.NOT_USED,
      }),
      cancel: jest.fn().mockResolvedValue(undefined),
    };

    await sut.reconcileCancelIntent(candidate);
    expect(sut.partnerCompanyExternService.cancel).toHaveBeenCalledWith(orderDelivery);

    expect(sut.deliveryCancelIntentService.markDbApplied).toHaveBeenCalledWith('31', slot, manager, expect.any(Date));
    expect(sut.deliveryCancelIntentService.markResolvedNoRefund).toHaveBeenCalledWith('31');
  });
});
