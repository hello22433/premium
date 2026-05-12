import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import {
  OrderDeliveryRefundEntity,
  OrderDeliveryRefundRestoreType,
  OrderDeliveryRefundSourcePath,
} from '../../entity/order.delivery.refund.entity';

export interface ClaimRefundInput {
  orderDeliveryId: number;
  userId: number;
  refundAmount: number;
  restoreType: OrderDeliveryRefundRestoreType;
  isSettleComplete: boolean;
  isSettleBalance: boolean;
  sourcePath: OrderDeliveryRefundSourcePath;
  operatorUserId?: number | null;
  memo?: string | null;
}

/**
 * 환불 멱등성 락 서비스.
 *
 * order_delivery_refund 테이블의 UNIQUE 제약을 이용해 동일 발송건에 대한
 * 중복 환불을 구조적으로 차단한다. PIN 발급 dedup 테이블과 동일 패턴.
 *
 * - claim(): 환불 실행 직전 호출. 중복이면 BadRequestException throw + 호출자 환불 스킵.
 * - release(): 재발송 성공 시 호출. row DELETE → 재실패 시 다시 환불 가능.
 * - {claim,release}WithManager(): 명시적 queryRunner 트랜잭션 사용 path 용.
 */
@Injectable()
export class RefundLedgerService {
  private readonly logger = new Logger(RefundLedgerService.name);

  constructor(
    @InjectRepository(OrderDeliveryRefundEntity)
    private readonly refundRepository: Repository<OrderDeliveryRefundEntity>,
    @InjectRepository(OrderDeliveryEntity)
    private readonly deliveryRepository: Repository<OrderDeliveryEntity>,
  ) {}

  async claim(input: ClaimRefundInput): Promise<void> {
    await this.insertLedger(this.refundRepository, input);
    await this.markRefundedAt(this.deliveryRepository, input.orderDeliveryId);
  }

  async release(orderDeliveryId: number): Promise<void> {
    await this.deleteLedger(this.refundRepository, orderDeliveryId);
    await this.clearRefundedAt(this.deliveryRepository, orderDeliveryId);
  }

  async claimWithManager(manager: EntityManager, input: ClaimRefundInput): Promise<void> {
    await this.insertLedger(manager.getRepository(OrderDeliveryRefundEntity), input);
    await this.markRefundedAt(manager.getRepository(OrderDeliveryEntity), input.orderDeliveryId);
  }

  async releaseWithManager(manager: EntityManager, orderDeliveryId: number): Promise<void> {
    await this.deleteLedger(manager.getRepository(OrderDeliveryRefundEntity), orderDeliveryId);
    await this.clearRefundedAt(manager.getRepository(OrderDeliveryEntity), orderDeliveryId);
  }

  private async insertLedger(
    repo: Repository<OrderDeliveryRefundEntity>,
    input: ClaimRefundInput,
  ): Promise<void> {
    try {
      await repo
        .createQueryBuilder()
        .insert()
        .into(OrderDeliveryRefundEntity)
        .values({
          orderDeliveryId: input.orderDeliveryId,
          userId: input.userId,
          refundAmount: input.refundAmount,
          restoreType: input.restoreType,
          isSettleComplete: input.isSettleComplete,
          isSettleBalance: input.isSettleBalance,
          sourcePath: input.sourcePath,
          operatorUserId: input.operatorUserId ?? null,
          memo: input.memo ?? null,
        })
        .execute();
    } catch (e: any) {
      if (e?.code === 'ER_DUP_ENTRY' || e?.errno === 1062) {
        this.logger.warn(
          `환불 중복 차단: orderDeliveryId=${input.orderDeliveryId}, sourcePath=${input.sourcePath}`,
        );
        throw new BadRequestException(
          `이미 환불된 발송건입니다. (orderDeliveryId: ${input.orderDeliveryId})`,
        );
      }
      throw e;
    }
  }

  private async deleteLedger(
    repo: Repository<OrderDeliveryRefundEntity>,
    orderDeliveryId: number,
  ): Promise<void> {
    await repo.delete({ orderDeliveryId });
  }

  private async markRefundedAt(
    repo: Repository<OrderDeliveryEntity>,
    orderDeliveryId: number,
  ): Promise<void> {
    await repo
      .createQueryBuilder()
      .update(OrderDeliveryEntity)
      .set({ refundedAt: () => 'CURRENT_TIMESTAMP(6)' })
      .where('id = :id', { id: orderDeliveryId })
      .execute();
  }

  private async clearRefundedAt(
    repo: Repository<OrderDeliveryEntity>,
    orderDeliveryId: number,
  ): Promise<void> {
    await repo.update({ id: orderDeliveryId }, { refundedAt: null });
  }
}
