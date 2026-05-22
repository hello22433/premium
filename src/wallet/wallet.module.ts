import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { WalletAccountEntity } from '../entity/wallet.account.entity';
import { WalletTransactionEntity } from '../entity/wallet.transaction.entity';
import { PointGrantEntity } from '../entity/point.grant.entity';
import { PointPolicyRuleEntity } from '../entity/point.policy.rule.entity';
import { CreditExcessApprovalEntity } from '../entity/credit.excess.approval.entity';
import { OrderPaymentAllocationEntity } from '../entity/order.payment.allocation.entity';
import { OrderPaymentAllocationLineEntity } from '../entity/order.payment.allocation.line.entity';
import { OrderPointUsageEntity } from '../entity/order.point.usage.entity';
import { OrderPaymentRefundEventEntity } from '../entity/order.payment.refund.event.entity';
import { OrderDeliveryAttemptEntity } from '../entity/order.delivery.attempt.entity';
import { UserEntity } from '../entity/user.entity';
import { WalletAccountResolverService } from './application/wallet-account-resolver.service';
import { PointPolicyService } from './application/point-policy.service';
import { PaymentAllocationService } from './application/payment-allocation.service';
import { WalletLedgerService } from './application/wallet-ledger.service';
import { CreditExcessApprovalService } from './application/credit-excess-approval.service';
import { OrderConfirmationWalletService } from './application/order-confirmation-wallet.service';
import { OrderConfirmationReleaseService } from './application/order-confirmation-release.service';
import { RefundPoolService } from './application/refund-pool.service';
import { SettleConfirmationWalletService } from './application/settle-confirmation-wallet.service';
import { WalletManagedPredicate } from './application/wallet-managed.predicate';
import { WalletCutoverBundleBootstrap } from './application/wallet-cutover-bundle.bootstrap';
import { ShadowMismatchClassifierService } from './application/shadow-mismatch-classifier.service';
import { WalletCutoverConfig } from './config/wallet-cutover.config';
import { SettlementCodeScopeGuard } from './api/settlement-code-scope.guard';

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
    AuthModule,
    ConfigModule,
    TypeOrmModule.forFeature([
      WalletAccountEntity,
      WalletTransactionEntity,
      PointGrantEntity,
      PointPolicyRuleEntity,
      CreditExcessApprovalEntity,
      OrderPaymentAllocationEntity,
      OrderPaymentAllocationLineEntity,
      OrderPointUsageEntity,
      OrderPaymentRefundEventEntity,
      OrderDeliveryAttemptEntity,
      UserEntity,
    ]),
  ],
  controllers: [],
  providers: [
    WalletAccountResolverService,
    PointPolicyService,
    PaymentAllocationService,
    WalletLedgerService,
    CreditExcessApprovalService,
    OrderConfirmationWalletService,
    OrderConfirmationReleaseService,
    RefundPoolService,
    SettleConfirmationWalletService,
    WalletManagedPredicate,
    WalletCutoverConfig,
    WalletCutoverBundleBootstrap,
    ShadowMismatchClassifierService,
    SettlementCodeScopeGuard,
  ],
  exports: [
    WalletAccountResolverService,
    PointPolicyService,
    PaymentAllocationService,
    WalletLedgerService,
    CreditExcessApprovalService,
    OrderConfirmationWalletService,
    OrderConfirmationReleaseService,
    RefundPoolService,
    SettleConfirmationWalletService,
    WalletManagedPredicate,
    WalletCutoverConfig,
    ShadowMismatchClassifierService,
    SettlementCodeScopeGuard,
  ],
})
export class WalletModule {}
