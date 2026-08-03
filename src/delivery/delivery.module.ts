import { Module, forwardRef } from '@nestjs/common';
import { DeliveryAlimTalkInfoBankHttp } from './infra/delivery.alim.talk.info.bank.http';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DeliverySendHistoryEntity } from '../entity/delivery.send.history.entity';
import { DeliveryBatchService } from './application/delivery.batch.service';
import { DeliverySendService } from './application/delivery.send.service';
import { OrderDeliveryEntity } from '../entity/order.delivery.entity';
import { OrderHistoryEntity } from '../entity/order.history.entity';
import { OrderDeliveryRefundEntity } from '../entity/order.delivery.refund.entity';
import { OrderDeliveryAttemptEntity } from '../entity/order.delivery.attempt.entity';
import { OrderPaymentRefundEventEntity } from '../entity/order.payment.refund.event.entity';
import { OrderPaymentAllocationEntity } from '../entity/order.payment.allocation.entity';
import { DeliveryBatchSchedule } from './delivery.batch.schedule';
import { RefundLedgerService } from './application/refund-ledger.service';
import { SsgRefundResolverService } from './application/ssg-refund.resolver';
import { SsgRecoveryService } from './application/ssg-recovery.service';
import { SsgRecoverySweepService } from './application/ssg-recovery-sweep.service';
import { SsgResendDeductRecoveryService } from './application/ssg-resend-deduct-recovery.service';
import { SsgResendDeductPendingEntity } from '../entity/ssg.resend.deduct.pending.entity';
import { SsgInsertStateModule } from './ssg.insert.state.module';
import { MailModule } from '../mail/mail.module';
import { SmsModule } from '../sms/sms.module';
import { OrderEntity } from '../entity/order.entity';
import { AuthModule } from '../auth/auth.module';
import { EmailSendHistoryEntity } from '../entity/email.send.history.entity';
import { FileModule } from '../file/file.module';
import { DeliveryTrackHttp } from './infra/delivery.track.http';
import { OrderRealProductEntity } from '../entity/order.real.product.entity';
import { OrderRealProductMappingEntity } from '../entity/order.real.product.mapping.entity';
import { UserEntity } from '../entity/user.entity';
import { SsgEventEntity } from '../entity/ssg.event.entity';
import { SsgIssueLogEntity } from '../entity/ssg.issue.log.entity';
import { PartnerCompanyExternModule } from '../partner_company_extern/partner.company.extern.module';
import { SsgEventModule } from '../ssg_event/ssg.event.module';
import { UserManagementModule } from '../user_management/user.management.module';
import { WalletModule } from '../wallet/wallet.module';
import { OrderFromModule } from '../order_from/order.from.module';
import { DeliveryWorkflowEntity } from '../entity/delivery.workflow.entity';
import { MessageAttemptEntity } from '../entity/message.attempt.entity';
import { DeliveryWorkflowSlotService } from './application/delivery-workflow-slot.service';
import { MessageAttemptService } from './application/message-attempt.service';
import { PinIssueCommandEntity } from '../entity/pin.issue.command.entity';
import { PinIssueCommandService } from './application/pin-issue-command.service';
import { MessageResultReconcileService } from './application/message-result-reconcile.service';
import { MessageResendExecutorService } from './application/message-resend-executor.service';
import { DeliveryCutoverModule } from './delivery.cutover.module';
import { RefundAttemptEntity } from '../entity/refund.attempt.entity';
import { DualApprovalEntity } from '../entity/dual.approval.entity';
import { RefundAttemptExecutorService } from './application/refund-attempt-executor.service';
import { StaleExternalResponseEntity } from '../entity/stale.external.response.entity';
import { DeliveryCancelIntentEntity } from '../entity/delivery.cancel.intent.entity';
import { DeliveryCancelIntentService } from './application/delivery-cancel-intent.service';

@Module({
  imports: [
    AuthModule,
    HttpModule.register({ timeout: 30000 }),
    TypeOrmModule.forFeature([
      OrderEntity,
      OrderDeliveryEntity,
      OrderDeliveryRefundEntity,
      OrderDeliveryAttemptEntity,
      OrderPaymentRefundEventEntity,
      OrderPaymentAllocationEntity,
      OrderRealProductEntity,
      OrderRealProductMappingEntity,
      DeliverySendHistoryEntity,
      EmailSendHistoryEntity,
      UserEntity,
      SsgEventEntity,
      SsgIssueLogEntity,
      OrderHistoryEntity,
      SsgResendDeductPendingEntity,
      DeliveryWorkflowEntity,
      MessageAttemptEntity,
      PinIssueCommandEntity,
      RefundAttemptEntity,
      DualApprovalEntity,
      StaleExternalResponseEntity,
      DeliveryCancelIntentEntity,
    ]),
    MailModule,
    SmsModule,
    FileModule,
    PartnerCompanyExternModule,
    SsgEventModule,
    UserManagementModule,
    SsgInsertStateModule,
    OrderFromModule,
    DeliveryCutoverModule,
    forwardRef(() => WalletModule),
  ],
  providers: [
    {
      provide: 'DeliveryAlimTalk',
      useClass: DeliveryAlimTalkInfoBankHttp,
    },
    DeliveryTrackHttp,
    DeliverySendService,
    DeliveryBatchService,
    DeliveryBatchSchedule,
    RefundLedgerService,
    SsgRefundResolverService,
    SsgRecoveryService,
    SsgRecoverySweepService,
    SsgResendDeductRecoveryService,
    DeliveryWorkflowSlotService,
    MessageAttemptService,
    PinIssueCommandService,
    MessageResultReconcileService,
    MessageResendExecutorService,
    RefundAttemptExecutorService,
    DeliveryCancelIntentService,
  ],
  exports: [
    {
      provide: 'DeliveryAlimTalk',
      useClass: DeliveryAlimTalkInfoBankHttp,
    },
    DeliveryTrackHttp,
    DeliverySendService,
    DeliveryBatchService,
    RefundLedgerService,
    SsgRefundResolverService,
    SsgRecoveryService,
    SsgRecoverySweepService,
    SsgResendDeductRecoveryService,
    DeliveryWorkflowSlotService,
    MessageAttemptService,
    MessageResultReconcileService,
    MessageResendExecutorService,
    RefundAttemptExecutorService,
    DeliveryCancelIntentService,
    SsgInsertStateModule,
    DeliveryCutoverModule,
  ],
})
export class DeliveryModule {}
