import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { OrderPaymentAllocationEntity } from '../../entity/order.payment.allocation.entity';
import { WalletLedgerService } from './wallet-ledger.service';
import { WalletResourceType } from '../interface/wallet-resource-type';

/**
 * 정산확정/정산해제 wallet 통합 (Cross-Cutting Invariants §2 settle_release / settle_undo).
 *  - settle_cycle_id 는 호출자가 제공 (PR4 settle UI에서 발급).
 *  - 정산확정: credit_used + credit_excess 감소.
 *  - 정산해제: 같은 금액 복원.
 *  - 예치금/포인트 사용분은 정산확정 시 변경 없음 (이미 발송확정 시점에 차감).
 */
@Injectable()
export class SettleConfirmationWalletService {
  constructor(
    @InjectRepository(OrderPaymentAllocationEntity)
    private readonly allocationRepository: Repository<OrderPaymentAllocationEntity>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ledger: WalletLedgerService,
  ) {}

  async confirmSettlement(
    orderId: number,
    settleCycleId: string,
  ): Promise<{ creditReleased: number; excessReleased: number }> {
    const alloc = await this.allocationRepository.findOne({ where: { orderId } });
    if (!alloc) throw new BadRequestException(`allocation not found for orderId=${orderId}`);

    const creditReleased = alloc.creditUsedAmount;
    const excessReleased = alloc.creditExcessAmount;

    if (creditReleased > 0) {
      await this.ledger.recordTransaction({
        walletAccountId: alloc.walletAccountId,
        orderId,
        type: 'SETTLE_RELEASE',
        resourceType: WalletResourceType.CREDIT,
        amount: -creditReleased,
        idempotencyKey: `settle_release:${orderId}::credit:${settleCycleId}`,
      });
    }
    if (excessReleased > 0) {
      await this.ledger.recordTransaction({
        walletAccountId: alloc.walletAccountId,
        orderId,
        type: 'SETTLE_RELEASE',
        resourceType: WalletResourceType.CREDIT_EXCESS,
        amount: -excessReleased,
        idempotencyKey: `settle_release:${orderId}::credit_excess:${settleCycleId}`,
      });
    }

    return { creditReleased, excessReleased };
  }

  async undoSettlement(
    orderId: number,
    settleCycleId: string,
  ): Promise<{ creditRestored: number; excessRestored: number }> {
    const alloc = await this.allocationRepository.findOne({ where: { orderId } });
    if (!alloc) throw new BadRequestException(`allocation not found for orderId=${orderId}`);

    const creditRestored = alloc.creditUsedAmount;
    const excessRestored = alloc.creditExcessAmount;

    if (creditRestored > 0) {
      await this.ledger.recordTransaction({
        walletAccountId: alloc.walletAccountId,
        orderId,
        type: 'SETTLE_UNDO',
        resourceType: WalletResourceType.CREDIT,
        amount: creditRestored,
        idempotencyKey: `settle_undo:${orderId}::credit:${settleCycleId}`,
      });
    }
    if (excessRestored > 0) {
      await this.ledger.recordTransaction({
        walletAccountId: alloc.walletAccountId,
        orderId,
        type: 'SETTLE_UNDO',
        resourceType: WalletResourceType.CREDIT_EXCESS,
        amount: excessRestored,
        idempotencyKey: `settle_undo:${orderId}::credit_excess:${settleCycleId}`,
      });
    }

    return { creditRestored, excessRestored };
  }
}
