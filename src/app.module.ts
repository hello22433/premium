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

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    BrandModule,
    DatabaseModule,
    UserModule,
    UserManagementModule,
    ProductModule,
    PartnerCompanyModule,
    NoticeModule,
    InquiryModule,
    OrderModule,
    DeliveryModule,
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
  ],
  controllers: [AppController],
  providers: [],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(LoggerMiddleware).forRoutes('*');
  }
}
