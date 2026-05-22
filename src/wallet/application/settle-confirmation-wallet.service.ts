import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OrderPaymentAllocationEntity } from '../../entity/order.payment.allocation.entity';
import { WalletLedgerService } from './wallet-ledger.service';
import { WalletResourceType } from '../interface/wallet-resource-type';

/**
 * 정산확정/정산해제 wallet 통합 (Cross-Cutting Invariants §2 settle_release / settle_undo).
 *  - 정산확정: credit_used + credit_excess 의 **잔여분** (used - restored) 만 release.
 *    이미 실패/폐기로 일부 환불된 후 정산확정이면 남은 부분만 감소.
 *  - 정산해제: 같은 잔여 금액만큼 복원.
 *  - 예치금/포인트 사용분은 정산확정 시 변화 없음.
 *  - 단일 트랜잭션 안에서 ledger same-manager 호출 (nested tx 회피).
 */
@Injectable()
export class SettleConfirmationWalletService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ledger: WalletLedgerService,
  ) {}

  async confirmSettlement(
    orderId: number,
    settleCycleId: string,
  ): Promise<{ creditReleased: number; excessReleased: number }> {
    return this.dataSource.transaction(async (manager) => {
      const alloc = await manager.findOne(OrderPaymentAllocationEntity, { where: { orderId } });
      if (!alloc) throw new BadRequestException(`allocation not found for orderId=${orderId}`);

      // 잔여분만 release (실패/폐기 환불분 제외)
      const creditReleased = Math.max(0, alloc.creditUsedAmount - alloc.creditUsedRestoredAmount);
      const excessReleased = Math.max(0, alloc.creditExcessAmount - alloc.creditExcessRestoredAmount);

      if (creditReleased > 0) {
        await this.ledger.recordTransaction(
          {
            walletAccountId: alloc.walletAccountId,
            orderId,
            type: 'SETTLE_RELEASE',
            resourceType: WalletResourceType.CREDIT,
            amount: -creditReleased,
            idempotencyKey: `settle_release:${orderId}::credit:${settleCycleId}`,
          },
          manager,
        );
      }
      if (excessReleased > 0) {
        await this.ledger.recordTransaction(
          {
            walletAccountId: alloc.walletAccountId,
            orderId,
            type: 'SETTLE_RELEASE',
            resourceType: WalletResourceType.CREDIT_EXCESS,
            amount: -excessReleased,
            idempotencyKey: `settle_release:${orderId}::credit_excess:${settleCycleId}`,
          },
          manager,
        );
      }

      return { creditReleased, excessReleased };
    });
  }

  async undoSettlement(
    orderId: number,
    settleCycleId: string,
  ): Promise<{ creditRestored: number; excessRestored: number }> {
    return this.dataSource.transaction(async (manager) => {
      const alloc = await manager.findOne(OrderPaymentAllocationEntity, { where: { orderId } });
      if (!alloc) throw new BadRequestException(`allocation not found for orderId=${orderId}`);

      // confirmSettlement 가 release 한 잔여분과 같은 금액 복원
      const creditRestored = Math.max(0, alloc.creditUsedAmount - alloc.creditUsedRestoredAmount);
      const excessRestored = Math.max(0, alloc.creditExcessAmount - alloc.creditExcessRestoredAmount);

      if (creditRestored > 0) {
        await this.ledger.recordTransaction(
          {
            walletAccountId: alloc.walletAccountId,
            orderId,
            type: 'SETTLE_UNDO',
            resourceType: WalletResourceType.CREDIT,
            amount: creditRestored,
            idempotencyKey: `settle_undo:${orderId}::credit:${settleCycleId}`,
          },
          manager,
        );
      }
      if (excessRestored > 0) {
        await this.ledger.recordTransaction(
          {
            walletAccountId: alloc.walletAccountId,
            orderId,
            type: 'SETTLE_UNDO',
            resourceType: WalletResourceType.CREDIT_EXCESS,
            amount: excessRestored,
            idempotencyKey: `settle_undo:${orderId}::credit_excess:${settleCycleId}`,
          },
          manager,
        );
      }

      return { creditRestored, excessRestored };
    });
  }
}
