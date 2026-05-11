import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  DataSource,
  EntitySubscriberInterface,
  EventSubscriber,
  TransactionCommitEvent,
  UpdateEvent,
} from 'typeorm';

import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { OrderDeliveryCouponStatus } from '../../delivery/interface/order.delivery.coupon.status';
import { COUPON_CANCELLED_EVENT, CouponCancelledEventPayload } from './coupon.cancelled.event';

const PENDING_KEY = '__couponCancelledPending';

@Injectable()
@EventSubscriber()
export class OrderDeliveryCancelSubscriber implements EntitySubscriberInterface<OrderDeliveryEntity> {
  private readonly logger = new Logger(OrderDeliveryCancelSubscriber.name);

  constructor(
    @InjectDataSource() dataSource: DataSource,
    private readonly eventEmitter: EventEmitter2,
  ) {
    dataSource.subscribers.push(this);
  }

  listenTo() {
    return OrderDeliveryEntity;
  }

  // afterUpdate에서 즉시 emit하면 트랜잭션 롤백 시 잘못된 통보가 나갈 수 있다.
  // queryRunner.data에 payload를 모아두고 afterTransactionCommit에서 일괄 emit한다.
  afterUpdate(event: UpdateEvent<OrderDeliveryEntity>): void {
    const entity = event.entity as Partial<OrderDeliveryEntity> | undefined;
    const dbEntity = event.databaseEntity;
    if (!entity || !dbEntity) return;

    const newStatus = entity.couponStatus;
    const oldStatus = dbEntity.couponStatus;
    if (newStatus === oldStatus) return;
    if (newStatus !== OrderDeliveryCouponStatus.CANCEL && newStatus !== OrderDeliveryCouponStatus.REFUND_CANCEL) return;

    const orderDeliveryId = (entity.id ?? dbEntity.id) as number | undefined;
    if (!orderDeliveryId) return;

    const payload: CouponCancelledEventPayload = {
      orderDeliveryId,
      couponStatus: newStatus,
      previousCouponStatus: oldStatus ?? null,
      cancelledAt: new Date(),
    };

    const queryRunner = event.queryRunner;
    if (!queryRunner) {
      // queryRunner가 없으면 트랜잭션 외부 — 안전하게 즉시 emit
      this.safeEmit(payload);
      return;
    }

    const pending = (queryRunner.data[PENDING_KEY] as CouponCancelledEventPayload[] | undefined) ?? [];
    pending.push(payload);
    queryRunner.data[PENDING_KEY] = pending;
  }

  afterTransactionCommit(event: TransactionCommitEvent): void {
    const queryRunner = event.queryRunner;
    const pending = queryRunner?.data?.[PENDING_KEY] as CouponCancelledEventPayload[] | undefined;
    if (!pending || pending.length === 0) return;

    queryRunner.data[PENDING_KEY] = [];
    for (const payload of pending) {
      this.safeEmit(payload);
    }
  }

  private safeEmit(payload: CouponCancelledEventPayload): void {
    try {
      this.eventEmitter.emit(COUPON_CANCELLED_EVENT, payload);
    } catch (err) {
      this.logger.error(`emit failed for orderDelivery ${payload.orderDeliveryId}`, err);
    }
  }
}
