import { BadRequestException, Injectable, Logger } from '@nestjs/common';
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
 * - idempotency_key UNIQUE 위반 (ER_DUP_ENTRY) → 트랜잭션 rollback + 기존 row 조회 후 success 변환.
 */
@Injectable()
export class WalletLedgerService {
  private readonly logger = new Logger(WalletLedgerService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async recordTransaction(input: RecordTransactionInput): Promise<RecordTransactionResult> {
    // Fast path: 이미 처리된 idempotency_key 면 잔액 변경 없이 바로 return.
    const existing = await this.dataSource
      .getRepository(WalletTransactionEntity)
      .findOne({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) {
      return {
        transactionId: existing.id,
        balanceAfter: existing.balanceAfter ?? 0,
        isDuplicate: true,
      };
    }

    try {
      return await this.dataSource.transaction(async (manager) => {
        // 1. 잔액 변경 (POINT: grant.remaining_amount, 그 외: wallet_account 컬럼)
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
            .andWhere(input.amount < 0 ? 'remaining_amount >= :need' : '1=1', {
              need: Math.abs(input.amount),
            })
            .execute();
          if (updateResult.affected !== 1) {
            throw new Error(
              `point_grant deduction conflict (id=${input.pointGrantId}, amount=${input.amount})`,
            );
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
          // 한도 invariant 검증 (concurrent race 차단)
          // CREDIT 가산 시: credit_used + amount <= credit_limit. 초과는 CREDIT_EXCESS 자원으로만 가능.
          if (
            input.resourceType === WalletResourceType.CREDIT &&
            input.amount > 0 &&
            wallet.creditUsedAmount + input.amount > wallet.creditLimit
          ) {
            throw new BadRequestException(
              `credit_limit_exceeded (concurrent race): walletId=${wallet.id}, used=${wallet.creditUsedAmount}, limit=${wallet.creditLimit}, requested=${input.amount}`,
            );
          }
          // 음수 차감 시 0 미만 차단 (복구 시 over-restore 방지)
          if (input.amount < 0 && (wallet as any)[field] + input.amount < 0) {
            throw new BadRequestException(
              `${input.resourceType.toLowerCase()}_underflow: walletId=${wallet.id}, current=${(wallet as any)[field]}, requested=${input.amount}`,
            );
          }
          (wallet as any)[field] = (wallet as any)[field] + input.amount;
          await manager.save(wallet);
          balanceAfter = (wallet as any)[field];
        }

        // 2. transaction row insert. UNIQUE 위반 시 throw → 전체 트랜잭션 rollback (잔액 변경도 롤백)
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
      });
    } catch (err) {
      if (this.isDuplicateKey(err)) {
        // Race: 다른 트랜잭션이 같은 키로 먼저 insert 완료. 트랜잭션 rollback 됐으므로 잔액 변경 X.
        // 기존 row 조회 후 idempotent success 반환.
        this.logger.warn(`idempotency_key race detected (rolled back, return existing): ${input.idempotencyKey}`);
        const fresh = await this.dataSource
          .getRepository(WalletTransactionEntity)
          .findOne({ where: { idempotencyKey: input.idempotencyKey } });
        return {
          transactionId: fresh?.id ?? '',
          balanceAfter: fresh?.balanceAfter ?? 0,
          isDuplicate: true,
        };
      }
      throw err;
    }
  }

  /**
   * 포인트 grant 발급.
   * point_grant.remaining_amount = amount 로 생성 + wallet_transaction GRANT row insert.
   * grant 자체가 ledger 엔티티 역할이므로 recordTransaction POINT 처리(grant remaining 갱신)는 호출하지 않는다.
   * idempotency UNIQUE 위반 시 트랜잭션 rollback (grant insert 도 롤백) + 기존 grant id 조회.
   */
  async issueGrant(input: IssueGrantInput): Promise<{ grantId: string; isDuplicate: boolean }> {
    // Fast path
    const existing = await this.dataSource
      .getRepository(WalletTransactionEntity)
      .findOne({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) {
      // 동일 키 사용으로 이미 발급된 grant 식별: pointGrantId 추적 불가 (wallet_transaction 에 grant id 컬럼 없음)
      // → grantId='' 반환. 호출자는 isDuplicate=true 로 처리.
      this.logger.warn(`grant idempotency_key already used (no-op): ${input.idempotencyKey}`);
      return { grantId: '', isDuplicate: true };
    }

    try {
      return await this.dataSource.transaction(async (manager) => {
        const grant = await manager.save(PointGrantEntity, {
          walletAccountId: input.walletAccountId,
          originalAmount: input.amount,
          remainingAmount: input.amount,
          expiresAt: input.expiresAt ?? null,
          reason: input.reason ?? null,
          active: 1,
        });

        // wallet_transaction GRANT row (audit + idempotency). grant remaining 변경 안 함.
        await manager.save(WalletTransactionEntity, {
          walletAccountId: input.walletAccountId,
          orderId: null,
          orderDeliveryId: null,
          type: 'GRANT',
          resourceType: WalletResourceType.POINT,
          amount: input.amount,
          balanceAfter: input.amount,
          memo: input.reason ?? null,
          idempotencyKey: input.idempotencyKey,
        });

        return { grantId: grant.id, isDuplicate: false };
      });
    } catch (err) {
      if (this.isDuplicateKey(err)) {
        this.logger.warn(`grant idempotency_key race (rolled back): ${input.idempotencyKey}`);
        return { grantId: '', isDuplicate: true };
      }
      throw err;
    }
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
