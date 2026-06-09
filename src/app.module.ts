import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AppController } from './app.controller';
import { UserModule } from './user/user.module';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { ProductModule } from './product/product.module';
import { PartnerCompanyModule } from './partner_company/partner.company.module';
import { BrandModule } from './brand/brand.module';
import { NoticeModule } from './notice/notice.module';
import { InquiryModule } from './inquiry/inquiry.module';
import { UserManagementModule } from './user_management/user.management.module';
import { OrderModule } from './order/order.module';
import { DeliveryModule } from './delivery/delivery.module';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { MailModule } from './mail/mail.module';
import { MulterModule } from '@nestjs/platform-express';
import { join } from 'path';
import { ServeStaticModule } from '@nestjs/serve-static';
import { LoggerMiddleware } from './common/api/logger.middleware';
import { MessageArchiveModule } from './message_archive/message.archive.module';
import { FileModule } from './file/file.module';
import { UserFindModule } from './user_find/user.find.module';
import { UserBizModule } from './user_biz/user.biz.module';
import { UserInfoModule } from './user_info/user.info.module';
import { UserDiscountModule } from './user_discount/user.discount.module';
import { SsgEventModule } from './ssg_event/ssg.event.module';
import { QnaModule } from './qna/qna.module';
import { UserDriveModule } from './user_drive/user.drive.module';
import { OrderRealProductModule } from './order_real_product/order.real.product.module';
import { OrderReceiveModule } from './order_receive/order.receive.module';
import { OrderFromModule } from './order_from/order.from.module';
import { UserTaskHistoryModule } from './user_task_history/user.task.history.module';
import { UserSyncProductModule } from './user_sync_product/user.sync.product.module';
import { ProductChoiceModule } from './product_choice/product.choice.module';
import { SettleModule } from './settle/settle.module';
import { CustomerServiceModule } from './customer_service/customer.service.module';
import { OrderEventModule } from './order_event/order.event.module';
import { ErpModule } from './erp/erp.module';
import { RefundModule } from './refund/refund.module';
import { ActivityLogModule } from './activity_log/activity.log.module';
import { EmailManualModule } from './email_manual/email.manual.module';
import { DepartmentModule } from './department/department.module';
import { PartnerCompanyExternHistoryModule } from './partner_company_extern_history/partner.company.extern.history.module';
import { PopularProductModule } from './popular_product/popular.product.module';
import { RequirementModule } from './requirement/requirement.module';
import { NotificationModule } from './notification/notification.module';
import { OrderReceiptModule } from './order_receipt/order.receipt.module';
import { ExternalApiModule } from './external_api/external.api.module';
import { ExternalApiWebhookModule } from './external_api/webhook/external.api.webhook.module';
import { SidebarModule } from './sidebar/sidebar.module';
import { WalletModule } from './wallet/wallet.module';
import { ForbiddenWordModule } from './forbidden_word/forbidden.word.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    BrandModule,
    DatabaseModule,
    UserModule,
    UserManagementModule,
    UserDiscountModule,
    ProductModule,
    PartnerCompanyModule,
    NoticeModule,
    InquiryModule,
    OrderModule,
    OrderRealProductModule,
    DeliveryModule,
    UserSyncProductModule,
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot(),
    MailModule,
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), 'public'),
      serveRoot: '/public',
    }),
    MulterModule.registerAsync({
      useFactory: () => ({}),
    }),
    MessageArchiveModule,
    FileModule,
    UserFindModule,
    UserBizModule,
    UserInfoModule,
    SsgEventModule,
    QnaModule,
    UserDriveModule,
    OrderReceiveModule,
    OrderFromModule,
    UserTaskHistoryModule,
    ProductChoiceModule,
    SettleModule,
    CustomerServiceModule,
    OrderEventModule,
    ErpModule,
    RefundModule,
    ActivityLogModule,
    EmailManualModule,
    DepartmentModule,
    PartnerCompanyExternHistoryModule,
    PopularProductModule,
    RequirementModule,
    NotificationModule,
    OrderReceiptModule,
    ExternalApiModule,
    ExternalApiWebhookModule,
    SidebarModule,
    WalletModule,
    ForbiddenWordModule,
  ],
  controllers: [AppController],
  providers: [],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(LoggerMiddleware).forRoutes('*');
  }
}
