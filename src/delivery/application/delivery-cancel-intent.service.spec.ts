import { Repository } from 'typeorm';
import { DeliveryCancelIntentEntity } from '../../entity/delivery.cancel.intent.entity';
import {
  DELIVERY_CANCEL_RECONCILE_REQUIRED,
  DeliveryCancelIntentSource,
  DeliveryCancelIntentStatus,
} from '../interface/delivery.cancel.intent.status';
import { RefundScope } from '../interface/refund.attempt.status';
import { DeliveryCancelIntentService } from './delivery-cancel-intent.service';
import { DeliverySlot } from './delivery-workflow-slot.service';

describe('DeliveryCancelIntentService', () => {
  const slot = {
    ownerToken: 'owner-1',
    workflowVersion: '7',
  } as DeliverySlot;
  const context = {
    requestedCouponStatus: 'CANCEL',
    refundRequired: true,
    requestedByUserId: 9,
    expectedRefundAmount: 5000,
    expectedRefundScope: RefundScope.FULL,
  };

  let repository: jest.Mocked<Repository<DeliveryCancelIntentEntity>>;
  let service: DeliveryCancelIntentService;

  beforeEach(() => {
    repository = {
      create: jest.fn((value) => value),
      save: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
      createQueryBuilder: jest.fn(),
    } as unknown as jest.Mocked<Repository<DeliveryCancelIntentEntity>>;
    service = new DeliveryCancelIntentService(repository);
  });

  it('persists a fenced PENDING intent before cancellation', async () => {
    repository.save.mockImplementation(async (value) => ({ id: '11', ...value }) as DeliveryCancelIntentEntity);

    const intent = await service.create(101, DeliveryCancelIntentSource.CUSTOMER_SERVICE, slot, context);

    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        orderDeliveryId: 101,
        source: DeliveryCancelIntentSource.CUSTOMER_SERVICE,
        status: DeliveryCancelIntentStatus.PENDING,
        requestedCouponStatus: 'CANCEL',
        refundRequired: true,
        requestedByUserId: 9,
        ownerToken: slot.ownerToken,
        workflowVersion: slot.workflowVersion,
      }),
    );
    expect(intent.id).toBe('11');
  });

  it('updates DB_APPLIED through the caller transaction with intent fencing', async () => {
    const execute = jest.fn().mockResolvedValue({ affected: 1 });
    const queryBuilder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute,
    };
    const manager = {
      getRepository: jest.fn().mockReturnValue({
        createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
      }),
    } as any;

    await service.markDbApplied('11', slot, manager);

    expect(queryBuilder.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: DeliveryCancelIntentStatus.DB_APPLIED,
        reconcileFromStatus: null,
      }),
    );
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('owner_token = :ownerToken', { ownerToken: slot.ownerToken });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('workflow_version = :workflowVersion', {
      workflowVersion: slot.workflowVersion,
    });
  });

  it('binds the exact refund attempt by delivery, amount, and scope in the claim transaction', async () => {
    const execute = jest.fn().mockResolvedValue({ affected: 1 });
    const queryBuilder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute,
    };
    const manager = {
      getRepository: jest.fn().mockReturnValue({
        createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
      }),
    } as any;
    const attempt = {
      id: '91',
      orderDeliveryId: 101,
      amount: 5000,
      scope: 'FULL',
    } as any;

    await service.bindRefundAttempt('11', attempt, manager);

    expect(queryBuilder.set).toHaveBeenCalledWith({ refundAttemptId: '91' });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('order_delivery_id = :orderDeliveryId', {
      orderDeliveryId: 101,
    });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('expected_refund_amount = :amount', { amount: 5000 });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('expected_refund_scope = :scope', { scope: 'FULL' });
  });

  it('closes refund success only when the persisted attempt binding still matches', async () => {
    const execute = jest.fn().mockResolvedValue({ affected: 1 });
    const queryBuilder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute,
    };
    repository.createQueryBuilder.mockReturnValue(queryBuilder as any);

    await service.markRefundSucceeded('11', {
      attemptId: '91',
      orderDeliveryId: 101,
      amount: 5000,
      scope: RefundScope.FULL,
    });

    expect(queryBuilder.andWhere).toHaveBeenCalledWith('refund_attempt_id = :refundAttemptId', {
      refundAttemptId: '91',
    });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('order_delivery_id = :orderDeliveryId', {
      orderDeliveryId: 101,
    });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('expected_refund_amount = :amount', { amount: 5000 });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('expected_refund_scope = :scope', { scope: RefundScope.FULL });
  });
  it('returns a reconciliation handle instead of recreating a duplicate intent', async () => {
    repository.save.mockRejectedValue({ code: 'ER_DUP_ENTRY' });
    repository.findOne.mockResolvedValue({
      id: '11',
      orderDeliveryId: 101,
      status: DeliveryCancelIntentStatus.CANCEL_CONFIRMED,
    } as DeliveryCancelIntentEntity);

    await expect(service.create(101, DeliveryCancelIntentSource.EXTERNAL_API, slot, context)).rejects.toMatchObject({
      response: expect.objectContaining({
        code: DELIVERY_CANCEL_RECONCILE_REQUIRED,
        cancelIntentId: '11',
      }),
    });
  });

  it('does not reopen an intent resolved without a refund', async () => {
    const execute = jest.fn().mockResolvedValue({ affected: 0 });
    const andWhere = jest.fn().mockReturnThis();
    const queryBuilder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere,
      execute,
    };
    repository.createQueryBuilder.mockReturnValue(queryBuilder as any);

    await service.markReconciling('11', 'late stale worker');

    expect(andWhere).toHaveBeenCalledWith('status NOT IN (:...resolved)', {
      resolved: [DeliveryCancelIntentStatus.REFUND_SUCCEEDED, DeliveryCancelIntentStatus.RESOLVED_NO_REFUND],
    });
  });
});
