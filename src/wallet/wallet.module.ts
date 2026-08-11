import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { WalletAccountEntity } from '../entity/wallet.account.entity';
import { WalletTransactionEntity } from '../entity/wallet.transaction.entity';
import { PointGrantEntity } from '../entity/point.grant.entity';
import { PointPolicyRuleEntity } from '../entity/point.policy.rule.entity';
import { CreditExcessApprovalEntity } from '../entity/credit.excess.approval.entity';
import { CreditExcessApprovalExecutionEntity } from '../entity/credit.excess.approval.execution.entity';
import { OrderPaymentAllocationEntity } from '../entity/order.payment.allocation.entity';
import { OrderPaymentAllocationLineEntity } from '../entity/order.payment.allocation.line.entity';
import { OrderPointUsageEntity } from '../entity/order.point.usage.entity';
import { OrderPaymentRefundEventEntity } from '../entity/order.payment.refund.event.entity';
import { OrderDeliveryAttemptEntity } from '../entity/order.delivery.attempt.entity';
import { UserEntity } from '../entity/user.entity';
import { UserCompanyEntity } from '../entity/user.company.entity';
import { ActivityLogEntity } from '../entity/activity.log.entity';
import { WalletAccountResolverService } from './application/wallet-account-resolver.service';
import { WalletReadService } from './application/wallet-read.service';
import { PointPolicyService } from './application/point-policy.service';
import { PaymentAllocationService } from './application/payment-allocation.service';
import { WalletAllocationInputBuilder } from './application/wallet-allocation-input.builder';
import { WalletLedgerService } from './application/wallet-ledger.service';
import { CreditExcessApprovalService } from './application/credit-excess-approval.service';
import { OrderConfirmationWalletService } from './application/order-confirmation-wallet.service';
import { OrderConfirmationReleaseService } from './application/order-confirmation-release.service';
import { RefundPoolService } from './application/refund-pool.service';
import { SettleConfirmationWalletService } from './application/settle-confirmation-wallet.service';
import { ResendDeductService } from './application/resend-deduct.service';
import { WalletManagedPredicate } from './application/wallet-managed.predicate';
import { WalletCutoverBundleBootstrap } from './application/wallet-cutover-bundle.bootstrap';
import { ShadowMismatchClassifierService } from './application/shadow-mismatch-classifier.service';
import { WalletCutoverConfig } from './config/wallet-cutover.config';
import { SettlementCodeScopeGuard } from './api/settlement-code-scope.guard';
import { LegacyWalletCreditSyncService } from './application/legacy-wallet-credit-sync.service';
import { BillingScopeLockService } from './application/billing-scope-lock.service';
import { SettlementCodeAdminService } from './application/settlement-code-admin.service';
import { SettlementCodeAdminController } from './api/settlement-code-admin.controller';
import { ActivityLogModule } from '../activity_log/activity.log.module';

/**
 * PR1 — schema + entity + service skeleton.
 *
 * **운영 wallet write 0 보장**: 본 PR 머지 시점에는 admin write endpoint / hook 호출 0건.
 * AllocationPreviewController / WalletAdminController 는 PR2 hook 통합 PR 에서 별 추가.
 *
 * service skeleton (Resolver/Policy/Allocation/Ledger/CreditExcessApproval/OrderConfirmation/RefundPool/SettleConfirmation)
 * 은 PR2 단계에서 fail-closed 또는 동일 트랜잭션 흡수 설계에 따라 호출 통합.
 */
@Module({
  imports: [
    ActivityLogModule,
    AuthModule,
    ConfigModule,
    TypeOrmModule.forFeature([
      WalletAccountEntity,
      WalletTransactionEntity,
      PointGrantEntity,
      PointPolicyRuleEntity,
      CreditExcessApprovalEntity,
      CreditExcessApprovalExecutionEntity,
      OrderPaymentAllocationEntity,
      OrderPaymentAllocationLineEntity,
      OrderPointUsageEntity,
      OrderPaymentRefundEventEntity,
      OrderDeliveryAttemptEntity,
      UserEntity,
      UserCompanyEntity,
      ActivityLogEntity,
    ]),
  ],
  controllers: [SettlementCodeAdminController],
  providers: [
    WalletAccountResolverService,
    WalletReadService,
    PointPolicyService,
    PaymentAllocationService,
    WalletAllocationInputBuilder,
    WalletLedgerService,
    CreditExcessApprovalService,
    OrderConfirmationWalletService,
    OrderConfirmationReleaseService,
    RefundPoolService,
    SettleConfirmationWalletService,
    ResendDeductService,
    WalletManagedPredicate,
    WalletCutoverConfig,
    WalletCutoverBundleBootstrap,
    ShadowMismatchClassifierService,
    SettlementCodeScopeGuard,
    LegacyWalletCreditSyncService,
    BillingScopeLockService,
    SettlementCodeAdminService,
    // WalletCutoverBundleBootstrap 의 activation gate 가 moduleRef.get(<string-token>)
    // 으로 downstream hook service 등록 여부를 검증한다 (PR3/PR4 hook 누락 → process exit 1).
    // class provider 만 등록 시 string token lookup 이 항상 null → false-negative.
    // 아래 useExisting alias 로 string-token 등록 동기화 (현재 PR2 범위 service 만).
    // PR4 의 ResendDeductService 는 본 PR2 범위에 미존재 → alias 미등록 → gate 가 정상적으로 missing 감지.
    { provide: 'SettleConfirmationWalletService', useExisting: SettleConfirmationWalletService },
    { provide: 'RefundPoolService', useExisting: RefundPoolService },
    { provide: 'ResendDeductService', useExisting: ResendDeductService },
  ],
  exports: [
    WalletAccountResolverService,
    WalletReadService,
    PointPolicyService,
    PaymentAllocationService,
    WalletAllocationInputBuilder,
    WalletLedgerService,
    CreditExcessApprovalService,
    OrderConfirmationWalletService,
    OrderConfirmationReleaseService,
    RefundPoolService,
    SettleConfirmationWalletService,
    ResendDeductService,
    WalletManagedPredicate,
    WalletCutoverConfig,
    ShadowMismatchClassifierService,
    SettlementCodeScopeGuard,
    LegacyWalletCreditSyncService,
    BillingScopeLockService,
    SettlementCodeAdminService,
  ],
})
export class WalletModule {}
