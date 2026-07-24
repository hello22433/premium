import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
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
  operatorId?: number | null; // 운영자 수동 거래(예치금 충전 등) 감사 정본
  operatorEmail?: string | null;
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
 *
 * 호출자가 EntityManager 를 넘기면 해당 트랜잭션 안에서 실행 (nested transaction 회피 + same-tx 보장).
 * 미전달 시 자체 트랜잭션 열음.
 */
@Injectable()
export class WalletLedgerService {
  private readonly logger = new Logger(WalletLedgerService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async recordTransaction(
    input: RecordTransactionInput,
    externalManager?: EntityManager,
  ): Promise<RecordTransactionResult> {
    if (externalManager) {
      return this.recordTransactionWithin(input, externalManager);
    }

    // Fast path: 자체 트랜잭션 모드에서만 사전 체크
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
        return this.recordTransactionWithin(input, manager);
      });
    } catch (err) {
      if (this.isDuplicateKey(err)) {
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
   * Same-transaction 변형. 호출자가 트랜잭션 매니저를 가지고 들어왔을 때 사용.
   * 외부 transaction 안에서 idempotency UNIQUE 위반 시 호출자가 catch → rollback 책임.
   */
  private async recordTransactionWithin(
    input: RecordTransactionInput,
    manager: EntityManager,
  ): Promise<RecordTransactionResult> {
    // 0. Same-tx fast path: 동일 idempotency_key 가 이미 처리됐다면 잔액 변경 없이 기존 row return.
    const existing = await manager.getRepository(WalletTransactionEntity).findOne({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing) {
      return {
        transactionId: existing.id,
        balanceAfter: existing.balanceAfter ?? 0,
        isDuplicate: true,
      };
    }

    // 1. 잔액 변경 (POINT: grant.remaining_amount, 그 외: wallet_account 컬럼)
    let balanceAfter: number;
    let balanceBefore: number | null = null;
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
      // 한도 invariant 검증 (concurrent race 차단)
      if (
        input.resourceType === WalletResourceType.CREDIT &&
        input.amount > 0 &&
        wallet.creditUsedAmount + input.amount > wallet.creditLimit
      ) {
        throw new BadRequestException(
          `credit_limit_exceeded (concurrent race): walletId=${wallet.id}, used=${wallet.creditUsedAmount}, limit=${wallet.creditLimit}, requested=${input.amount}`,
        );
      }
      if (input.amount < 0 && (wallet as any)[field] + input.amount < 0) {
        throw new BadRequestException(
          `${input.resourceType.toLowerCase()}_underflow: walletId=${wallet.id}, current=${(wallet as any)[field]}, requested=${input.amount}`,
        );
      }
      balanceBefore = (wallet as any)[field];
      (wallet as any)[field] = (wallet as any)[field] + input.amount;
      await manager.save(wallet);
      balanceAfter = (wallet as any)[field];
    }

    // 2. transaction row insert. UNIQUE 위반 시 throw → 호출자/외부 트랜잭션이 rollback 처리
    const inserted = await manager.getRepository(WalletTransactionEntity).save({
      walletAccountId: input.walletAccountId,
      orderId: input.orderId ?? null,
      orderDeliveryId: input.orderDeliveryId ?? null,
      type: input.type,
      resourceType: input.resourceType,
      amount: input.amount,
      balanceAfter,
      balanceBefore,
      operatorId: input.operatorId ?? null,
      operatorEmail: input.operatorEmail ?? null,
      memo: input.memo ?? null,
      idempotencyKey: input.idempotencyKey,
    });
    return { transactionId: inserted.id, balanceAfter, isDuplicate: false };
  }

  /**
   * 포인트 grant 발급.
   * point_grant.remaining_amount = amount 로 생성 + wallet_transaction GRANT row insert.
   * grant 자체가 ledger 엔티티 역할이므로 recordTransaction POINT 처리(grant remaining 갱신)는 호출하지 않는다.
   */
  async issueGrant(input: IssueGrantInput): Promise<{ grantId: string; isDuplicate: boolean }> {
    const existing = await this.dataSource
      .getRepository(WalletTransactionEntity)
      .findOne({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) {
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
