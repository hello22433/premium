import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { addTransactionalDataSource, getDataSourceByName } from 'typeorm-transactional';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { UserEntity } from '../entity/user.entity';
import { UserCompanyEntity } from '../entity/user.company.entity';
import { ProductEntity } from '../entity/product.entity';
import { InquiryEntity } from '../entity/inquiry.entity';
import { NoticeEntity } from '../entity/notice.entity';
import { UserDiscountEntity } from '../entity/user.discount.entity';
import { BrandEntity } from '../entity/brand.entity';
import { EventEntity } from '../entity/event.entity';
import { EventProductMappingEntity } from '../entity/event.product.mapping.entity';
import { MessageArchiveEntity } from '../entity/message.archive.entity';
import { UserEventSaveMappingEntity } from '../entity/user.event.save.mapping.entity';
import { OrderEntity } from '../entity/order.entity';
import { OrderProductMappingEntity } from '../entity/order.product.mapping.entity';
import { PartnerCompanyEntity } from '../entity/partner.company.entity';
import { OrderDeliveryEntity } from '../entity/order.delivery.entity';
import { OrderDeliveryRefundEntity } from '../entity/order.delivery.refund.entity';
import { TestOrderDeliveryEntity } from '../entity/test.order.delivery.entity';
import { DeliverySendHistoryEntity } from '../entity/delivery.send.history.entity';
import { PartnerCompanyExternHistoryEntity } from '../entity/partner.company.extern.history.entity';
import { ProductUpdateHistoryEntity } from '../entity/product.update.history.entity';
import { EmailSendHistoryEntity } from '../entity/email.send.history.entity';
import { SqlLogger } from '../common/api/sql.logger';
import { SsgEventAmountHistoryEntity } from '../entity/ssg.event.amount.history.entity';
import { SsgEventRecoveryLogEntity } from '../entity/ssg.event.recovery.log.entity';
import { SsgResendDeductRecoveryLogEntity } from '../entity/ssg.resend.deduct.recovery.log.entity';
import { SsgEventEntity } from '../entity/ssg.event.entity';
import { SsgReservationRangeEntity } from '../entity/ssg.reservation.range.entity';
import { GemteckMsgQueueEntity } from '../entity/gemtek/msg.queue.entity';
import { QnaEntity } from '../entity/qna.entity';
import { UserDriveEntity } from '../entity/user.drive.entity';
import { OrderRealProductEntity } from '../entity/order.real.product.entity';
import { OrderRealProductMappingEntity } from '../entity/order.real.product.mapping.entity';
import { OrderFromDefinitionEntity } from '../entity/order.from.definition.entity';
import { UserTaskHistoryEntity } from '../entity/user.task.history.entity';
import { ProductChoiceMappingEntity } from '../entity/product.choice.mapping.entity';
import { UserSyncProductEventMappingEntity } from '../entity/user.sync.product.event.mapping.entity';
import { UserSyncProductEventEntity } from '../entity/user.sync.product.event.entity';
import { OrderLikeEntity } from '../entity/order.like.entity';
import { ProductLikeEntity } from '../entity/product.like.entity';
import { OtherServiceSaleEntity } from '../entity/other.service.sale.entity';
import { OtherServiceSaleProductEntity } from '../entity/other.service.sale.product.entity';
import { OtherServiceSaleProductMappingEntity } from '../entity/other.service.sale.product.mapping.entity';
import { OtherServiceSaleTypeEntity } from '../entity/other.service.sale.type.entity';
import { ShippingStorageEntity } from '../entity/shipping.storage.entity';
import { OrderHistoryEntity } from 'src/entity/order.history.entity';
import { ActivityLogEntity } from '../entity/activity.log.entity';
import { ClassificationEntity } from '../entity/classification.entity';
import { PasswordPolicyEntity } from '../entity/password.policy.entity';
import { EmailManualEntity } from '../entity/email.manual.entity';
import { DepartmentEntity } from '../entity/department.entity';
import { UserViewScopeEntity } from '../entity/user.view.scope.entity';
import { GalaxiaBarcodeLogEntity } from '../entity/galaxia.barcode.log.entity';
import { RequirementEntity } from '../entity/requirement.entity';
import { RequirementCommentEntity } from '../entity/requirement.comment.entity';
import { RequirementAttachmentEntity } from '../entity/requirement.attachment.entity';
import { OrderReceiptEntity } from '../entity/order.receipt.entity';
import { ProductSharedListFileEntity } from '../entity/product.shared.list.file.entity';
import { OrderManualEntryEntity } from '../entity/order.manual.entry.entity';
import { PinIssueDedupEntity } from '../entity/pin.issue.dedup.entity';
import { SsgIssueLogEntity } from '../entity/ssg.issue.log.entity';
import { OrderDeliverySsgInsertStateEntity } from '../entity/order.delivery.ssg.insert.state.entity';
import { EarlyDestroyRequestEntity } from '../entity/early.destroy.request.entity';
import { EarlyDestroyRequestItemEntity } from '../entity/early.destroy.request.item.entity';
import { IdempotencyKeyEntity } from '../entity/idempotency.key.entity';
import { PopularProductEntity } from '../entity/popular.product.entity';
import { GiftielExchangeHistoryEntity } from '../entity/giftiel.exchange.history.entity';
import { ExternalApiAccountEntity } from '../entity/external.api.account.entity';
import { ExternalApiAllowedIpEntity } from '../entity/external.api.allowed.ip.entity';
import { ExternalApiSsgRequestEntity } from '../entity/external.api.ssg.request.entity';
import { ExternalApiWebhookLogEntity } from '../entity/external.api.webhook.log.entity';
import { WalletAccountEntity } from '../entity/wallet.account.entity';
import { WalletTransactionEntity } from '../entity/wallet.transaction.entity';
import { PointGrantEntity } from '../entity/point.grant.entity';
import { PointPolicyRuleEntity } from '../entity/point.policy.rule.entity';
import { OrderPaymentAllocationEntity } from '../entity/order.payment.allocation.entity';
import { OrderPaymentAllocationLineEntity } from '../entity/order.payment.allocation.line.entity';
import { OrderPointUsageEntity } from '../entity/order.point.usage.entity';
import { CreditExcessApprovalEntity } from '../entity/credit.excess.approval.entity';
import { OrderPaymentRefundEventEntity } from '../entity/order.payment.refund.event.entity';
import { OrderDeliveryAttemptEntity } from '../entity/order.delivery.attempt.entity';
import { ForbiddenWordEntity } from '../entity/forbidden.word.entity';
import { ForbiddenWordHistoryEntity } from '../entity/forbidden.word.history.entity';
import { ForbiddenWordBlockLogEntity } from '../entity/forbidden.word.block.log.entity';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'mysql',
        host: configService.get('DATABASE_HOST'),
        port: +configService.get('DATABASE_PORT'),
        username: configService.get('DATABASE_USERNAME'),
        password: configService.get('DATABASE_PASSWORD'),
        database: configService.get('DATABASE_DATABASE'),
        entities: [
          UserEntity,
          UserCompanyEntity,
          ProductEntity,
          InquiryEntity,
          NoticeEntity,
          UserDiscountEntity,
          BrandEntity,
          ClassificationEntity,
          EventEntity,
          EventProductMappingEntity,
          MessageArchiveEntity,
          UserEventSaveMappingEntity,
          OrderEntity,
          OrderHistoryEntity,
          OrderProductMappingEntity,
          OrderRealProductEntity,
          OrderRealProductMappingEntity,
          PartnerCompanyEntity,
          OrderDeliveryEntity,
          OrderDeliveryRefundEntity,
          TestOrderDeliveryEntity,
          DeliverySendHistoryEntity,
          PartnerCompanyExternHistoryEntity,
          ProductUpdateHistoryEntity,
          EmailSendHistoryEntity,
          SsgEventAmountHistoryEntity,
          SsgEventRecoveryLogEntity,
          SsgResendDeductRecoveryLogEntity,
          SsgEventEntity,
          SsgReservationRangeEntity,
          QnaEntity,
          UserDriveEntity,
          UserSyncProductEventEntity,
          UserSyncProductEventMappingEntity,
          OrderFromDefinitionEntity,
          UserTaskHistoryEntity,
          ProductChoiceMappingEntity,
          OrderLikeEntity,
          ProductLikeEntity,
          OtherServiceSaleEntity,
          OtherServiceSaleProductEntity,
          OtherServiceSaleProductMappingEntity,
          OtherServiceSaleTypeEntity,
          ShippingStorageEntity,
          ActivityLogEntity,
          PasswordPolicyEntity,
          EmailManualEntity,
          DepartmentEntity,
          UserViewScopeEntity,
          GalaxiaBarcodeLogEntity,
          RequirementEntity,
          RequirementCommentEntity,
          RequirementAttachmentEntity,
          OrderReceiptEntity,
          ProductSharedListFileEntity,
          OrderManualEntryEntity,
          PinIssueDedupEntity,
          SsgIssueLogEntity,
          OrderDeliverySsgInsertStateEntity,
          EarlyDestroyRequestEntity,
          EarlyDestroyRequestItemEntity,
          IdempotencyKeyEntity,
          PopularProductEntity,
          GiftielExchangeHistoryEntity,
          ExternalApiAccountEntity,
          ExternalApiAllowedIpEntity,
          ExternalApiSsgRequestEntity,
          ExternalApiWebhookLogEntity,
          WalletAccountEntity,
          WalletTransactionEntity,
          PointGrantEntity,
          PointPolicyRuleEntity,
          OrderPaymentAllocationEntity,
          OrderPaymentAllocationLineEntity,
          OrderPointUsageEntity,
          CreditExcessApprovalEntity,
          OrderPaymentRefundEventEntity,
          OrderDeliveryAttemptEntity,
          ForbiddenWordEntity,
          ForbiddenWordHistoryEntity,
          ForbiddenWordBlockLogEntity,
        ],
        extra: {
          connectionLimit: +configService.get('DATABASE_CONNECTION_LIMIT', 50),
        },
        timezone: '+09:00',
        logger: configService.get('DATABASE_LOGGING') === 'true' ? new SqlLogger() : undefined,
        namingStrategy: new SnakeNamingStrategy(),
        logging: configService.get('DATABASE_LOGGING') === 'true',
        synchronize: configService.get('DATABASE_SYNCHRONIZE') === 'true',
      }),
      async dataSourceFactory(options) {
        if (!options) {
          throw new Error('Invalid options passed');
        }

        const existingDataSource = getDataSourceByName('default');
        if (existingDataSource) {
          return existingDataSource;
        }

        return addTransactionalDataSource(new DataSource(options));
      },
    }),
    TypeOrmModule.forRootAsync({
      name: 'gemtek_sms',
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'mssql',
        host: configService.get('DATABASE_GEMTEK_SMS_HOST'),
        port: +configService.get('DATABASE_GEMTEK_SMS_PORT'),
        username: configService.get('DATABASE_GEMTEK_SMS_USERNAME'),
        password: configService.get('DATABASE_GEMTEK_SMS_PASSWORD'),
        database: configService.get('DATABASE_GEMTEK_SMS_DATABASE'),
        entities: [GemteckMsgQueueEntity],
        logging: configService.get('DATABASE_LOGGING') === 'true',
        synchronize: false,
        options: {
          encrypt: false, // TLS 암호화 비활성화
          trustServerCertificate: true, // 인증서 검증 무시
        },
      }),
    }),
  ],
})
export class DatabaseModule {}
