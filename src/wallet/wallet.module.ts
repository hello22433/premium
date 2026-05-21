import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
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
import { RefundPoolService } from './application/refund-pool.service';
import { SettleConfirmationWalletService } from './application/settle-confirmation-wallet.service';
import { WalletAdminController } from './api/wallet.admin.controller';
import { AllocationPreviewController } from './api/allocation-preview.controller';
import { SettlementCodeScopeGuard } from './api/settlement-code-scope.guard';

@Module({
  imports: [
    AuthModule,
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
  controllers: [WalletAdminController, AllocationPreviewController],
  providers: [
    WalletAccountResolverService,
    PointPolicyService,
    PaymentAllocationService,
    WalletLedgerService,
    CreditExcessApprovalService,
    OrderConfirmationWalletService,
    RefundPoolService,
    SettleConfirmationWalletService,
    SettlementCodeScopeGuard,
  ],
  exports: [
    WalletAccountResolverService,
    PointPolicyService,
    PaymentAllocationService,
    WalletLedgerService,
    CreditExcessApprovalService,
    OrderConfirmationWalletService,
    RefundPoolService,
    SettleConfirmationWalletService,
    SettlementCodeScopeGuard,
  ],
})
export class WalletModule {}
