import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { OrderPaymentAllocationEntity } from '../../entity/order.payment.allocation.entity';
import { OrderPaymentAllocationLineEntity } from '../../entity/order.payment.allocation.line.entity';
import { WalletAccountEntity } from '../../entity/wallet.account.entity';
import { WalletTransactionEntity } from '../../entity/wallet.transaction.entity';
import { WalletResourceType } from '../interface/wallet-resource-type';

const RESEND_DEDUCT_TYPE = 'RESEND_DEDUCT';
const RESEND_UNDO_TYPE = 'RESEND_UNDO';

export interface ResendDeductInput {
  orderId: number;
  orderDeliveryId: number;
  attemptId: string;
}

export interface ResendDeductResult {
  deducted: { deposit: number; credit: number; excess: number };
  walletTransactionIds: string[];
}

/**
 * 재발송 차감 (Cross-Cutting Invariants §2 resend_deduct + plan PR4).
 *
 * 흐름:
 *   TX0: order_delivery_attempt(attempt_type='RESEND', status='PENDING') row INSERT (caller).
 *   TX1: resendDeduct({orderId, orderDeliveryId, attemptId}, manager) — wallet 잔액 재차감 +
 *        wallet_transaction(resend_deduct) row split.
 *   TX2: caller 가 외부 호출 (PIN 재발급, 메시지 enqueue) 수행. 실패 시 resendUndo 보상.
 *
 * Lock 순서 표준 §3: wallet_account → allocation → wallet_transaction.
 * 멱등키: resend_deduct:{orderId}:{deliveryId}:{resource}:{attemptId}.
 * attemptId 가 cycle id 라 같은 attempt 재호출 시 멱등.
 *
 * 차감 금액 = 해당 line 의 deposit_used / credit_used / credit_excess. 라인은 발송확정 시점에
 * 결정된 분배 그대로 사용 (재발송 시 재계산 안 함).
 */
@Injectable()
export class ResendDeductService {
  private readonly logger = new Logger(ResendDeductService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async resendDeduct(
    input: ResendDeductInput,
    externalManager?: EntityManager,
  ): Promise<ResendDeductResult> {
    if (externalManager) {
      return this.runDeduct(input, externalManager);
    }
    return this.dataSource.transaction(async (m) => this.runDeduct(input, m));
  }

  async resendUndo(
    input: ResendDeductInput,
    externalManager?: EntityManager,
  ): Promise<ResendDeductResult> {
    if (externalManager) {
      return this.runUndo(input, externalManager);
    }
    return this.dataSource.transaction(async (m) => this.runUndo(input, m));
  }

  private async runDeduct(
    input: ResendDeductInput,
    manager: EntityManager,
  ): Promise<ResendDeductResult> {
    const { alloc, walletLock, line } = await this.lockChainAndLoad(input.orderId, input.orderDeliveryId, manager);

    const depositAmt = line.depositUsedAmount;
    const creditAmt = line.creditUsedAmount;
    const excessAmt = line.creditExcessAmount;
    const walletTransactionIds: string[] = [];
    const keyBase = `resend_deduct:${input.orderId}:${input.orderDeliveryId}`;

    if (depositAmt > 0) {
      walletLock.depositBalance -= depositAmt;
      await manager.save(WalletAccountEntity, walletLock);
      const tx = await manager.save(WalletTransactionEntity, {
        walletAccountId: alloc.walletAccountId,
        orderId: input.orderId,
        orderDeliveryId: input.orderDeliveryId,
        type: RESEND_DEDUCT_TYPE,
        resourceType: WalletResourceType.DEPOSIT,
        amount: -depositAmt,
        balanceAfter: walletLock.depositBalance,
        memo: `resend_deduct attempt=${input.attemptId}`,
        idempotencyKey: `${keyBase}:deposit:${input.attemptId}`,
      });
      walletTransactionIds.push(tx.id);
    }

    if (creditAmt > 0) {
      walletLock.creditUsedAmount += creditAmt;
      await manager.save(WalletAccountEntity, walletLock);
      const tx = await manager.save(WalletTransactionEntity, {
        walletAccountId: alloc.walletAccountId,
        orderId: input.orderId,
        orderDeliveryId: input.orderDeliveryId,
        type: RESEND_DEDUCT_TYPE,
        resourceType: WalletResourceType.CREDIT,
        amount: creditAmt,
        balanceAfter: walletLock.creditUsedAmount,
        memo: `resend_deduct attempt=${input.attemptId}`,
        idempotencyKey: `${keyBase}:credit:${input.attemptId}`,
      });
      walletTransactionIds.push(tx.id);
    }

    if (excessAmt > 0) {
      walletLock.creditExcessAmount += excessAmt;
      await manager.save(WalletAccountEntity, walletLock);
      const tx = await manager.save(WalletTransactionEntity, {
        walletAccountId: alloc.walletAccountId,
        orderId: input.orderId,
        orderDeliveryId: input.orderDeliveryId,
        type: RESEND_DEDUCT_TYPE,
        resourceType: WalletResourceType.CREDIT_EXCESS,
        amount: excessAmt,
        balanceAfter: walletLock.creditExcessAmount,
        memo: `resend_deduct attempt=${input.attemptId}`,
        idempotencyKey: `${keyBase}:credit_excess:${input.attemptId}`,
      });
      walletTransactionIds.push(tx.id);
    }

    this.logger.log(
      `resend_deduct orderId=${input.orderId} deliveryId=${input.orderDeliveryId} attempt=${input.attemptId} ` +
        `deposit=${depositAmt} credit=${creditAmt} excess=${excessAmt}`,
    );

    return {
      deducted: { deposit: depositAmt, credit: creditAmt, excess: excessAmt },
      walletTransactionIds,
    };
  }

  private async runUndo(
    input: ResendDeductInput,
    manager: EntityManager,
  ): Promise<ResendDeductResult> {
    const { alloc, walletLock, line } = await this.lockChainAndLoad(input.orderId, input.orderDeliveryId, manager);

    const depositAmt = line.depositUsedAmount;
    const creditAmt = line.creditUsedAmount;
    const excessAmt = line.creditExcessAmount;
    const walletTransactionIds: string[] = [];
    const keyBase = `resend_undo:${input.orderId}:${input.orderDeliveryId}`;

    if (depositAmt > 0) {
      walletLock.depositBalance += depositAmt;
      await manager.save(WalletAccountEntity, walletLock);
      const tx = await manager.save(WalletTransactionEntity, {
        walletAccountId: alloc.walletAccountId,
        orderId: input.orderId,
        orderDeliveryId: input.orderDeliveryId,
        type: RESEND_UNDO_TYPE,
        resourceType: WalletResourceType.DEPOSIT,
        amount: depositAmt,
        balanceAfter: walletLock.depositBalance,
        memo: `resend_undo attempt=${input.attemptId}`,
        idempotencyKey: `${keyBase}:deposit:${input.attemptId}`,
      });
      walletTransactionIds.push(tx.id);
    }

    if (creditAmt > 0) {
      walletLock.creditUsedAmount -= creditAmt;
      await manager.save(WalletAccountEntity, walletLock);
      const tx = await manager.save(WalletTransactionEntity, {
        walletAccountId: alloc.walletAccountId,
        orderId: input.orderId,
        orderDeliveryId: input.orderDeliveryId,
        type: RESEND_UNDO_TYPE,
        resourceType: WalletResourceType.CREDIT,
        amount: -creditAmt,
        balanceAfter: walletLock.creditUsedAmount,
        memo: `resend_undo attempt=${input.attemptId}`,
        idempotencyKey: `${keyBase}:credit:${input.attemptId}`,
      });
      walletTransactionIds.push(tx.id);
    }

    if (excessAmt > 0) {
      walletLock.creditExcessAmount -= excessAmt;
      await manager.save(WalletAccountEntity, walletLock);
      const tx = await manager.save(WalletTransactionEntity, {
        walletAccountId: alloc.walletAccountId,
        orderId: input.orderId,
        orderDeliveryId: input.orderDeliveryId,
        type: RESEND_UNDO_TYPE,
        resourceType: WalletResourceType.CREDIT_EXCESS,
        amount: -excessAmt,
        balanceAfter: walletLock.creditExcessAmount,
        memo: `resend_undo attempt=${input.attemptId}`,
        idempotencyKey: `${keyBase}:credit_excess:${input.attemptId}`,
      });
      walletTransactionIds.push(tx.id);
    }

    return {
      deducted: { deposit: depositAmt, credit: creditAmt, excess: excessAmt },
      walletTransactionIds,
    };
  }

  private async lockChainAndLoad(
    orderId: number,
    orderDeliveryId: number,
    manager: EntityManager,
  ): Promise<{
    alloc: OrderPaymentAllocationEntity;
    walletLock: WalletAccountEntity;
    line: OrderPaymentAllocationLineEntity;
  }> {
    const peekAlloc = await manager.findOne(OrderPaymentAllocationEntity, { where: { orderId } });
    if (!peekAlloc) {
      throw new BadRequestException(
        `ResendDeductService: allocation not found for orderId=${orderId}`,
      );
    }

    const walletLock = await manager
      .getRepository(WalletAccountEntity)
      .createQueryBuilder('w')
      .setLock('pessimistic_write')
      .where('w.id = :id', { id: peekAlloc.walletAccountId })
      .getOne();
    if (!walletLock) {
      throw new BadRequestException(
        `ResendDeductService: wallet_account not found id=${peekAlloc.walletAccountId}`,
      );
    }

    const alloc = await manager
      .getRepository(OrderPaymentAllocationEntity)
      .createQueryBuilder('a')
      .setLock('pessimistic_write')
      .where('a.orderId = :orderId', { orderId })
      .getOne();
    if (!alloc) {
      throw new BadRequestException(
        `ResendDeductService: allocation disappeared after peek (orderId=${orderId})`,
      );
    }

    const line = await manager.findOne(OrderPaymentAllocationLineEntity, {
      where: { allocationId: alloc.id, orderDeliveryId },
    });
    if (!line) {
      throw new BadRequestException(
        `ResendDeductService: allocation line not found (allocationId=${alloc.id}, deliveryId=${orderDeliveryId})`,
      );
    }

    return { alloc, walletLock, line };
  }
}
