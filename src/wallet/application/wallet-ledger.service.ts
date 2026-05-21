import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryFailedError } from 'typeorm';
import { WalletAccountEntity } from '../../entity/wallet.account.entity';
import { WalletTransactionEntity } from '../../entity/wallet.transaction.entity';
import { PointGrantEntity } from '../../entity/point.grant.entity';
import { WalletResourceType } from '../interface/wallet-resource-type';

export interface RecordTransactionInput {
  walletAccountId: string;
  orderId?: number | null;
  orderDeliveryId?: number | null;
  type: string; // CONFIRM | FAIL_REFUND | RESEND_DEDUCT | SETTLE_RELEASE | GRANT 등
  resourceType: WalletResourceType;
  amount: number; // 차감 음수, 적립/복구 양수
  pointGrantId?: string | null; // resourceType=POINT 일 때
  memo?: string | null;
  idempotencyKey: string;
}

export interface RecordTransactionResult {
  transactionId: string;
  balanceAfter: number;
  isDuplicate: boolean;
}

export interface IssueGrantInput {
  walletAccountId: string;
  amount: number;
  expiresAt?: Date | null;
  reason?: string | null;
  idempotencyKey: string;
}

/**
 * wallet ledger.
 * - 잔액 갱신: SELECT ... FOR UPDATE row lock (§3).
 * - point_grant 차감: 조건부 UPDATE + affectedRows 검증.
 * - row split: resource_type 별 row 1개 (§1).
 * - idempotency_key UNIQUE 위반 (ER_DUP_ENTRY) → success 변환.
 */
@Injectable()
export class WalletLedgerService {
  private readonly logger = new Logger(WalletLedgerService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async recordTransaction(input: RecordTransactionInput): Promise<RecordTransactionResult> {
    return this.dataSource.transaction(async (manager) => {
      // 1. 잔액 row lock
      let balanceAfter: number;
      if (input.resourceType === WalletResourceType.POINT) {
        if (!input.pointGrantId) {
          throw new Error('point_grant_id required for POINT resource_type');
        }
        const updateResult = await manager
          .createQueryBuilder()
          .update(PointGrantEntity)
          .set({
            remainingAmount: () =>
              input.amount >= 0
                ? `remaining_amount + ${Math.abs(input.amount)}`
                : `remaining_amount - ${Math.abs(input.amount)}`,
          })
          .where('id = :id AND active = 1', { id: input.pointGrantId })
          .andWhere(input.amount < 0 ? 'remaining_amount >= :need' : '1=1', { need: Math.abs(input.amount) })
          .execute();
        if (updateResult.affected !== 1) {
          throw new Error(`point_grant deduction conflict (id=${input.pointGrantId}, amount=${input.amount})`);
        }
        const grant = await manager.findOne(PointGrantEntity, { where: { id: input.pointGrantId } });
        balanceAfter = grant?.remainingAmount ?? 0;
      } else {
        const wallet = await manager
          .getRepository(WalletAccountEntity)
          .createQueryBuilder('w')
          .setLock('pessimistic_write')
          .where('w.id = :id', { id: input.walletAccountId })
          .getOne();
        if (!wallet) throw new Error(`wallet_account not found id=${input.walletAccountId}`);

        const field = this.fieldOf(input.resourceType);
        (wallet as any)[field] = (wallet as any)[field] + input.amount;
        await manager.save(wallet);
        balanceAfter = (wallet as any)[field];
      }

      // 2. transaction row insert (idempotency UNIQUE 위반 시 success 변환)
      try {
        const inserted = await manager.getRepository(WalletTransactionEntity).save({
          walletAccountId: input.walletAccountId,
          orderId: input.orderId ?? null,
          orderDeliveryId: input.orderDeliveryId ?? null,
          type: input.type,
          resourceType: input.resourceType,
          amount: input.amount,
          balanceAfter,
          memo: input.memo ?? null,
          idempotencyKey: input.idempotencyKey,
        });
        return { transactionId: inserted.id, balanceAfter, isDuplicate: false };
      } catch (err) {
        if (this.isDuplicateKey(err)) {
          this.logger.warn(`idempotency_key duplicate (success no-op): ${input.idempotencyKey}`);
          const existing = await manager.getRepository(WalletTransactionEntity).findOne({
            where: { idempotencyKey: input.idempotencyKey },
          });
          return {
            transactionId: existing?.id ?? '',
            balanceAfter: existing?.balanceAfter ?? balanceAfter,
            isDuplicate: true,
          };
        }
        throw err;
      }
    });
  }

  async issueGrant(input: IssueGrantInput): Promise<{ grantId: string; isDuplicate: boolean }> {
    return this.dataSource.transaction(async (manager) => {
      const grant = await manager.save(PointGrantEntity, {
        walletAccountId: input.walletAccountId,
        originalAmount: input.amount,
        remainingAmount: input.amount,
        expiresAt: input.expiresAt ?? null,
        reason: input.reason ?? null,
        active: 1,
      });

      const result = await this.recordTransaction({
        walletAccountId: input.walletAccountId,
        type: 'GRANT',
        resourceType: WalletResourceType.POINT,
        amount: input.amount,
        pointGrantId: grant.id,
        memo: input.reason,
        idempotencyKey: input.idempotencyKey,
      });
      return { grantId: grant.id, isDuplicate: result.isDuplicate };
    });
  }

  private fieldOf(resourceType: WalletResourceType): keyof WalletAccountEntity {
    switch (resourceType) {
      case WalletResourceType.DEPOSIT:
        return 'depositBalance';
      case WalletResourceType.CREDIT:
        return 'creditUsedAmount';
      case WalletResourceType.CREDIT_EXCESS:
        return 'creditExcessAmount';
      default:
        throw new Error(`unsupported resource_type for wallet_account: ${resourceType}`);
    }
  }

  private isDuplicateKey(err: unknown): boolean {
    if (!(err instanceof QueryFailedError)) return false;
    const driverErr = (err as any).driverError;
    return driverErr?.code === 'ER_DUP_ENTRY' || driverErr?.errno === 1062;
  }
}
