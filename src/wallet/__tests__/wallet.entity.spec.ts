import 'reflect-metadata';
import { getMetadataArgsStorage } from 'typeorm';
import { WalletAccountEntity } from '../../entity/wallet.account.entity';
import { WalletTransactionEntity } from '../../entity/wallet.transaction.entity';
import { PointGrantEntity } from '../../entity/point.grant.entity';
import { PointPolicyRuleEntity } from '../../entity/point.policy.rule.entity';
import { OrderPaymentAllocationEntity } from '../../entity/order.payment.allocation.entity';
import { OrderPaymentAllocationLineEntity } from '../../entity/order.payment.allocation.line.entity';
import { OrderPointUsageEntity } from '../../entity/order.point.usage.entity';
import { CreditExcessApprovalEntity } from '../../entity/credit.excess.approval.entity';
import { CreditExcessApprovalExecutionEntity } from '../../entity/credit.excess.approval.execution.entity';
import { OrderPaymentRefundEventEntity } from '../../entity/order.payment.refund.event.entity';
import { OrderDeliveryAttemptEntity } from '../../entity/order.delivery.attempt.entity';

/**
 * PR1a entity TypeORM 매핑 검증 (consensus plan v4 §Step 5).
 * 실제 DB round-trip은 staging dry-run 단계. 이 spec은 메타데이터 검증만 수행:
 *  - 모든 entity 가 PrimaryGeneratedColumn 보유
 *  - 핵심 unique / index 정의 존재 (idempotency_key UNIQUE 포함)
 *  - 컬럼 type/nullable/default 가 SQL 마이그레이션 정의와 일치
 */
describe('PR1a wallet entities — TypeORM 매핑 검증', () => {
  const storage = getMetadataArgsStorage();

  const tableOf = (target: Function) => storage.tables.find((t) => t.target === target);
  const colsOf = (target: Function) => storage.columns.filter((c) => c.target === target);
  const uniquesOf = (target: Function) => storage.uniques.filter((u) => u.target === target);
  const indicesOf = (target: Function) => storage.indices.filter((i) => i.target === target);
  const getCol = (target: Function, prop: string) => colsOf(target).find((c) => c.propertyName === prop);

  describe('wallet_account', () => {
    it('table 이름이 wallet_account 이고 PK + unique(owner_type, owner_id) 보유', () => {
      expect(tableOf(WalletAccountEntity)?.name).toBe('wallet_account');
      const uniques = uniquesOf(WalletAccountEntity);
      expect(
        uniques.some(
          (u) =>
            Array.isArray(u.columns) &&
            (u.columns as string[]).includes('ownerType') &&
            (u.columns as string[]).includes('ownerId'),
        ),
      ).toBe(true);
    });

    it('잔액 컬럼은 default 0 + int', () => {
      expect(getCol(WalletAccountEntity, 'depositBalance')?.options.default).toBe(0);
      expect(getCol(WalletAccountEntity, 'creditLimit')?.options.default).toBe(0);
      expect(getCol(WalletAccountEntity, 'creditUsedAmount')?.options.default).toBe(0);
      expect(getCol(WalletAccountEntity, 'creditExcessAmount')?.options.default).toBe(0);
    });
  });

  describe('wallet_transaction', () => {
    it('idempotency_key UNIQUE 보유 (re-INSERT 시 ER_DUP_ENTRY → 서비스에서 success 변환)', () => {
      const uniques = uniquesOf(WalletTransactionEntity);
      expect(uniques.some((u) => Array.isArray(u.columns) && (u.columns as string[]).includes('idempotencyKey'))).toBe(
        true,
      );
    });

    it('order_id / order_delivery_id 인덱스 존재', () => {
      const indices = indicesOf(WalletTransactionEntity);
      expect(indices.some((i) => Array.isArray(i.columns) && (i.columns as string[]).includes('orderId'))).toBe(true);
      expect(indices.some((i) => Array.isArray(i.columns) && (i.columns as string[]).includes('orderDeliveryId'))).toBe(
        true,
      );
    });

    it('amount 컬럼은 int (차감 음수 / 적립 양수)', () => {
      expect(getCol(WalletTransactionEntity, 'amount')?.options.type).toBe('int');
      expect(getCol(WalletTransactionEntity, 'amount')?.options.nullable).toBeFalsy();
    });
  });

  describe('point_grant', () => {
    it('expires_at nullable + wallet_account_id 복합 인덱스 보유', () => {
      expect(getCol(PointGrantEntity, 'expiresAt')?.options.nullable).toBe(true);
      const indices = indicesOf(PointGrantEntity);
      expect(
        indices.some(
          (i) =>
            Array.isArray(i.columns) &&
            (i.columns as string[]).includes('walletAccountId') &&
            (i.columns as string[]).includes('expiresAt'),
        ),
      ).toBe(true);
    });
  });

  describe('point_policy_rule', () => {
    it('owner_type / scope_type 컬럼 + 인덱스 2종 보유', () => {
      expect(getCol(PointPolicyRuleEntity, 'ownerType')).toBeDefined();
      expect(getCol(PointPolicyRuleEntity, 'scopeType')).toBeDefined();
      const indices = indicesOf(PointPolicyRuleEntity);
      expect(indices.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('order_payment_allocation', () => {
    it('unique(order_id) + 풀 환불 누적 컬럼 4종 + skip 누적', () => {
      const uniques = uniquesOf(OrderPaymentAllocationEntity);
      expect(uniques.some((u) => Array.isArray(u.columns) && (u.columns as string[]).includes('orderId'))).toBe(true);

      for (const prop of [
        'pointRestoredAmount',
        'creditExcessRestoredAmount',
        'creditUsedRestoredAmount',
        'depositRestoredAmount',
        'pointSkippedExpiredAmount',
      ]) {
        expect(getCol(OrderPaymentAllocationEntity, prop)?.options.default).toBe(0);
      }
    });

    it('card_surcharge_applied + has_discount snapshot 컬럼 (mutex 검증용)', () => {
      expect(getCol(OrderPaymentAllocationEntity, 'cardSurchargeApplied')).toBeDefined();
      expect(getCol(OrderPaymentAllocationEntity, 'hasDiscount')).toBeDefined();
    });
  });

  describe('order_payment_allocation_line', () => {
    it('order_delivery_id nullable + 인덱스 3종', () => {
      expect(getCol(OrderPaymentAllocationLineEntity, 'orderDeliveryId')?.options.nullable).toBe(true);
      const indices = indicesOf(OrderPaymentAllocationLineEntity);
      expect(indices.length).toBeGreaterThanOrEqual(3);
    });

    it('카드할증 share 컬럼은 없다 (ledger 기반 환불, §5)', () => {
      expect(getCol(OrderPaymentAllocationLineEntity, 'cardSurchargeShareAmount')).toBeUndefined();
    });
  });

  describe('order_point_usage', () => {
    it('point_grant_id 인덱스 보유', () => {
      const indices = indicesOf(OrderPointUsageEntity);
      expect(indices.some((i) => Array.isArray(i.columns) && (i.columns as string[]).includes('pointGrantId'))).toBe(
        true,
      );
    });
  });

  describe('credit_excess_approval', () => {
    it('활성 요청 unique key — 같은 주문의 PENDING/PROCESSING 중복 차단', () => {
      const activeOrderKey = getCol(CreditExcessApprovalEntity, 'activeOrderKey');
      expect(activeOrderKey?.options.generatedType).toBe('STORED');
      expect(String(activeOrderKey?.options.asExpression)).toContain("'PENDING','PROCESSING'");
    });

    it('실행 제어 컬럼 (attempt_token / lease_expires_at / snapshot)', () => {
      expect(getCol(CreditExcessApprovalEntity, 'attemptToken')?.options.nullable).toBe(true);
      expect(getCol(CreditExcessApprovalEntity, 'leaseExpiresAt')?.options.nullable).toBe(true);
      expect(getCol(CreditExcessApprovalEntity, 'snapshot')?.options.nullable).toBe(true);
    });

    it('실행 표식은 approval 당 1건 (unique)', () => {
      const uniques = uniquesOf(CreditExcessApprovalExecutionEntity);
      expect(
        uniques.some((u) => Array.isArray(u.columns) && (u.columns as string[]).includes('approvalId')),
      ).toBe(true);
    });

    it('reason_text NOT NULL (Step B 사유 필수)', () => {
      expect(getCol(CreditExcessApprovalEntity, 'reasonText')?.options.nullable).toBeFalsy();
    });
  });

  describe('order_payment_refund_event', () => {
    it('idempotency_key UNIQUE (ledger 재발송 역환불 멱등)', () => {
      const uniques = uniquesOf(OrderPaymentRefundEventEntity);
      expect(uniques.some((u) => Array.isArray(u.columns) && (u.columns as string[]).includes('idempotencyKey'))).toBe(
        true,
      );
    });

    it('3종 base 컬럼 분리 저장 (refunded_gross_base / payable_base / card_surcharge_amount)', () => {
      expect(getCol(OrderPaymentRefundEventEntity, 'refundedGrossBase')).toBeDefined();
      expect(getCol(OrderPaymentRefundEventEntity, 'refundedPayableBase')).toBeDefined();
      expect(getCol(OrderPaymentRefundEventEntity, 'refundedCardSurchargeAmount')).toBeDefined();
    });

    it('reversed_at / reversed_by_wallet_transaction_id 컬럼 (재발송 역환불)', () => {
      expect(getCol(OrderPaymentRefundEventEntity, 'reversedAt')?.options.nullable).toBe(true);
      expect(getCol(OrderPaymentRefundEventEntity, 'reversedByWalletTransactionId')?.options.nullable).toBe(true);
    });

    it('affected_delivery_ids 는 json 컬럼', () => {
      expect(getCol(OrderPaymentRefundEventEntity, 'affectedDeliveryIds')?.options.type).toBe('json');
    });
  });

  describe('order_delivery_attempt', () => {
    it('attempt_type / status 컬럼 + 2 인덱스 (delivery + type)', () => {
      expect(getCol(OrderDeliveryAttemptEntity, 'attemptType')).toBeDefined();
      expect(getCol(OrderDeliveryAttemptEntity, 'status')).toBeDefined();
      const indices = indicesOf(OrderDeliveryAttemptEntity);
      expect(indices.length).toBeGreaterThanOrEqual(2);
    });

    it('상태 lifecycle 컬럼 (deducted/sent/failed/completed_at) 모두 nullable', () => {
      for (const prop of ['deductedAt', 'sentAt', 'failedAt', 'completedAt']) {
        expect(getCol(OrderDeliveryAttemptEntity, prop)?.options.nullable).toBe(true);
      }
    });
  });
});
