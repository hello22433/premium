import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { addTransactionalDataSource } from 'typeorm-transactional';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { UserEntity } from '../entity/user.entity';
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
import { DeliverySendHistoryEntity } from '../entity/delivery.send.history.entity';
import { PartnerCompanyExternHistoryEntity } from '../entity/partner.company.extern.history.entity';
import { ProductUpdateHistoryEntity } from '../entity/product.update.history.entity';

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
          ProductEntity,
          InquiryEntity,
          NoticeEntity,
          UserDiscountEntity,
          BrandEntity,
          EventEntity,
          EventProductMappingEntity,
          MessageArchiveEntity,
          UserEventSaveMappingEntity,
          OrderEntity,
          OrderProductMappingEntity,
          PartnerCompanyEntity,
          OrderDeliveryEntity,
          DeliverySendHistoryEntity,
          PartnerCompanyExternHistoryEntity,
          ProductUpdateHistoryEntity,
        ],
        timezone: 'local',
        namingStrategy: new SnakeNamingStrategy(),
        logging: configService.get('DATABASE_LOGGING') === 'true',
        synchronize: configService.get('DATABASE_SYNCHRONIZE') === 'true',
      }),
      async dataSourceFactory(options) {
        if (!options) {
          throw new Error('Invalid options passed');
        }

        return addTransactionalDataSource(new DataSource(options));
      },
    }),
    // TypeOrmModule.forRootAsync({
    //   name: 'gemtek_sms',
    //   inject: [ConfigService],
    //   useFactory: (configService: ConfigService) => ({
    //     type: 'mssql',
    //     host: configService.get('DATABASE_GEMTEK_SMS_HOST'),
    //     port: +configService.get('DATABASE_GEMTEK_SMS_PORT'),
    //     username: configService.get('DATABASE_GEMTEK_SMS_USERNAME'),
    //     password: configService.get('DATABASE_GEMTEK_SMS_PASSWORD'),
    //     database: configService.get('DATABASE_GEMTEK_SMS_DATABASE'),
    //     entities: [GemteckMsgQueueEntity],
    //     logging: configService.get('DATABASE_LOGGING') === 'true',
    //     synchronize: false,
    //     options: {
    //       encrypt: false, // TLS 암호화 비활성화
    //       trustServerCertificate: true, // 인증서 검증 무시
    //     },
    //   }),
    // }),
  ],
})
export class DatabaseModule {}
