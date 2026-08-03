import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import { DeliveryCancelIntentEntity } from '../../entity/delivery.cancel.intent.entity';
import { RefundAttemptEntity } from '../../entity/refund.attempt.entity';
import { RefundScope } from '../interface/refund.attempt.status';
import {
  DELIVERY_CANCEL_RECONCILE_REQUIRED,
  DeliveryCancelIntentSource,
  DeliveryCancelIntentStatus,
} from '../interface/delivery.cancel.intent.status';
import { DeliverySlot } from './delivery-workflow-slot.service';

export interface CreateDeliveryCancelIntentContext {
  requestedCouponStatus: string;
  refundRequired: boolean;
  requestedByUserId?: number | null;
  expectedRefundAmount?: number | null;
  expectedRefundScope?: RefundScope | null;
}

export interface CancelIntentRefundBinding {
  attemptId: string;
  orderDeliveryId: number;
  amount: number;
  scope: RefundScope;
}

const OPEN_CANCEL_INTENT_STATUSES = [
  DeliveryCancelIntentStatus.PENDING,
  DeliveryCancelIntentStatus.CANCEL_CONFIRMED,
  DeliveryCancelIntentStatus.DB_APPLIED,
  DeliveryCancelIntentStatus.RECONCILING,
];

@Injectable()
export class DeliveryCancelIntentService {
  constructor(
    @InjectRepository(DeliveryCancelIntentEntity)
    private readonly intentRepository: Repository<DeliveryCancelIntentEntity>,
  ) {}

  async create(
    orderDeliveryId: number,
    source: DeliveryCancelIntentSource,
    slot: DeliverySlot,
    context: CreateDeliveryCancelIntentContext,
  ): Promise<DeliveryCancelIntentEntity> {
    if (
      context.refundRequired &&
      (context.expectedRefundAmount === null ||
        context.expectedRefundAmount === undefined ||
        context.expectedRefundScope === null ||
        context.expectedRefundScope === undefined)
    ) {
      throw new ConflictException({
        code: 'DELIVERY_CANCEL_REFUND_EXPECTATION_REQUIRED',
        orderDeliveryId,
      });
    }
    try {
      return await this.intentRepository.save(
        this.intentRepository.create({
          orderDeliveryId,
          source,
          status: DeliveryCancelIntentStatus.PENDING,
          reconcileFromStatus: null,
          requestedCouponStatus: context.requestedCouponStatus,
          refundRequired: context.refundRequired,
          requestedByUserId: context.requestedByUserId ?? null,
          refundAttemptId: null,
          expectedRefundAmount: context.expectedRefundAmount ?? null,
          expectedRefundScope: context.expectedRefundScope ?? null,
          ownerToken: slot.ownerToken,
          workflowVersion: slot.workflowVersion,
          externalCancelledAt: null,
          resolvedAt: null,
          failureReason: null,
          stateEnteredAt: new Date(),
        }),
      );
    } catch (error: any) {
      if (error?.code !== 'ER_DUP_ENTRY' && error?.errno !== 1062) {
        throw error;
      }
      const existing = await this.intentRepository.findOne({ where: { orderDeliveryId } });
      throw new ConflictException({
        code: DELIVERY_CANCEL_RECONCILE_REQUIRED,
        orderDeliveryId,
        cancelIntentId: existing?.id ?? null,
        status: existing?.status ?? null,
      });
    }
  }

  async findOpen(source: DeliveryCancelIntentSource, limit = 50): Promise<DeliveryCancelIntentEntity[]> {
    return await this.intentRepository.find({
      where: {
        source,
        status: In(OPEN_CANCEL_INTENT_STATUSES),
      },
      order: { stateEnteredAt: 'ASC', id: 'ASC' },
      take: limit,
    });
  }

  async getRequired(id: string): Promise<DeliveryCancelIntentEntity> {
    const intent = await this.intentRepository.findOne({ where: { id } });
    if (!intent) {
      throw this.reconcileRequired(id);
    }
    return intent;
  }

  async bindRefundAttempt(id: string, attempt: RefundAttemptEntity, manager: EntityManager): Promise<void> {
    const result = await manager
      .getRepository(DeliveryCancelIntentEntity)
      .createQueryBuilder()
      .update(DeliveryCancelIntentEntity)
      .set({ refundAttemptId: attempt.id })
      .where('id = :id', { id })
      .andWhere('order_delivery_id = :orderDeliveryId', {
        orderDeliveryId: attempt.orderDeliveryId,
      })
      .andWhere('expected_refund_amount = :amount', { amount: attempt.amount })
      .andWhere('expected_refund_scope = :scope', { scope: attempt.scope })
      .andWhere(
        `(status = :dbApplied OR
          (status = :reconciling AND reconcile_from_status = :dbApplied))`,
        {
          dbApplied: DeliveryCancelIntentStatus.DB_APPLIED,
          reconciling: DeliveryCancelIntentStatus.RECONCILING,
        },
      )
      .execute();
    if (!result.affected) {
      throw this.reconcileRequired(id);
    }
  }

  async claimForReconcile(id: string, slot: DeliverySlot): Promise<DeliveryCancelIntentEntity> {
    const result = await this.intentRepository
      .createQueryBuilder()
      .update(DeliveryCancelIntentEntity)
      .set({
        ownerToken: slot.ownerToken,
        workflowVersion: slot.workflowVersion,
        stateEnteredAt: new Date(),
      })
      .where('id = :id', { id })
      .andWhere('status IN (:...statuses)', { statuses: OPEN_CANCEL_INTENT_STATUSES })
      .execute();
    if (!result.affected) {
      throw this.reconcileRequired(id);
    }

    const intent = await this.intentRepository.findOne({ where: { id } });
    if (!intent) {
      throw this.reconcileRequired(id);
    }
    return intent;
  }

  effectiveStatus(intent: DeliveryCancelIntentEntity): DeliveryCancelIntentStatus {
    return intent.status === DeliveryCancelIntentStatus.RECONCILING
      ? (intent.reconcileFromStatus ?? DeliveryCancelIntentStatus.PENDING)
      : intent.status;
  }

  async markExternalCancelled(id: string, slot: DeliverySlot, now = new Date()): Promise<void> {
    const result = await this.intentRepository
      .createQueryBuilder()
      .update(DeliveryCancelIntentEntity)
      .set({
        status: DeliveryCancelIntentStatus.CANCEL_CONFIRMED,
        reconcileFromStatus: null,
        externalCancelledAt: now,
        stateEnteredAt: now,
        failureReason: null,
      })
      .where('id = :id', { id })
      .andWhere('owner_token = :ownerToken', { ownerToken: slot.ownerToken })
      .andWhere('workflow_version = :workflowVersion', { workflowVersion: slot.workflowVersion })
      .andWhere(
        `(status = :pending OR
          (status = :reconciling AND reconcile_from_status = :pending))`,
        {
          pending: DeliveryCancelIntentStatus.PENDING,
          reconciling: DeliveryCancelIntentStatus.RECONCILING,
        },
      )
      .execute();
    if (!result.affected) {
      throw this.reconcileRequired(id);
    }
  }

  async markDbApplied(id: string, slot: DeliverySlot, manager: EntityManager, now = new Date()): Promise<void> {
    const result = await manager
      .getRepository(DeliveryCancelIntentEntity)
      .createQueryBuilder()
      .update(DeliveryCancelIntentEntity)
      .set({
        status: DeliveryCancelIntentStatus.DB_APPLIED,
        reconcileFromStatus: null,
        stateEnteredAt: now,
        failureReason: null,
      })
      .where('id = :id', { id })
      .andWhere('owner_token = :ownerToken', { ownerToken: slot.ownerToken })
      .andWhere('workflow_version = :workflowVersion', { workflowVersion: slot.workflowVersion })
      .andWhere(
        `(status = :confirmed OR
          (status = :reconciling AND reconcile_from_status = :confirmed))`,
        {
          confirmed: DeliveryCancelIntentStatus.CANCEL_CONFIRMED,
          reconciling: DeliveryCancelIntentStatus.RECONCILING,
        },
      )
      .execute();
    if (!result.affected) {
      throw this.reconcileRequired(id);
    }
  }

  async markRefundSucceeded(id: string, binding: CancelIntentRefundBinding, now = new Date()): Promise<void> {
    await this.markResolved(id, DeliveryCancelIntentStatus.REFUND_SUCCEEDED, now, binding);
  }

  async markResolvedNoRefund(id: string, now = new Date()): Promise<void> {
    await this.markResolved(id, DeliveryCancelIntentStatus.RESOLVED_NO_REFUND, now);
  }

  async markReconciling(id: string, reason: string, now = new Date()): Promise<void> {
    await this.intentRepository
      .createQueryBuilder()
      .update(DeliveryCancelIntentEntity)
      .set({
        reconcileFromStatus: () =>
          `CASE WHEN status = '${DeliveryCancelIntentStatus.RECONCILING}' THEN reconcile_from_status ELSE status END`,
        status: DeliveryCancelIntentStatus.RECONCILING,
        stateEnteredAt: now,
        failureReason: reason.slice(0, 500),
      })
      .where('id = :id', { id })
      .andWhere('status NOT IN (:...resolved)', {
        resolved: [DeliveryCancelIntentStatus.REFUND_SUCCEEDED, DeliveryCancelIntentStatus.RESOLVED_NO_REFUND],
      })
      .execute();
  }

  private async markResolved(
    id: string,
    status: DeliveryCancelIntentStatus.REFUND_SUCCEEDED | DeliveryCancelIntentStatus.RESOLVED_NO_REFUND,
    now: Date,
    binding?: CancelIntentRefundBinding,
  ): Promise<void> {
    const query = this.intentRepository
      .createQueryBuilder()
      .update(DeliveryCancelIntentEntity)
      .set({
        status,
        reconcileFromStatus: null,
        stateEnteredAt: now,
        resolvedAt: now,
        failureReason: null,
      })
      .where('id = :id', { id })
      .andWhere(
        `(status = :dbApplied OR
          (status = :reconciling AND reconcile_from_status = :dbApplied))`,
        {
          dbApplied: DeliveryCancelIntentStatus.DB_APPLIED,
          reconciling: DeliveryCancelIntentStatus.RECONCILING,
        },
      );
    if (binding) {
      query
        .andWhere('refund_attempt_id = :refundAttemptId', {
          refundAttemptId: binding.attemptId,
        })
        .andWhere('order_delivery_id = :orderDeliveryId', {
          orderDeliveryId: binding.orderDeliveryId,
        })
        .andWhere('expected_refund_amount = :amount', {
          amount: binding.amount,
        })
        .andWhere('expected_refund_scope = :scope', {
          scope: binding.scope,
        });
    }

    const result = await query.execute();
    if (!result.affected) {
      throw this.reconcileRequired(id);
    }
  }

  private reconcileRequired(id: string): ConflictException {
    return new ConflictException({
      code: DELIVERY_CANCEL_RECONCILE_REQUIRED,
      cancelIntentId: id,
    });
  }
}
