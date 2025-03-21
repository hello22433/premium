import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { SsgEventEntity } from '../entity/ssg.event.entity';
import { SsgEventController } from './api/ssg.event.controller';
import { SsgEventService } from './application/ssg.event.service';
import { SsgEventAmountHistoryEntity } from '../entity/ssg.event.amount.history.entity';
import { OrderDeliveryEntity } from '../entity/order.delivery.entity';
import { OrderProductMappingEntity } from '../entity/order.product.mapping.entity';

@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([
      OrderProductMappingEntity,
      OrderDeliveryEntity,
      SsgEventEntity,
      SsgEventAmountHistoryEntity,
    ]),
  ],
  controllers: [SsgEventController],
  providers: [SsgEventService],
})
export class SsgEventModule {}
