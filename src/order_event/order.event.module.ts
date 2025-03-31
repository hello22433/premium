import { Module } from '@nestjs/common';
import { OrderEventController } from './api/order.event.controller';
import { OrderEventService } from './application/order.event.service';
import { AuthModule } from '../auth/auth.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrderEntity } from '../entity/order.entity';
import { OrderLikeEntity } from '../entity/order.like.entity';

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([OrderEntity, OrderLikeEntity])],
  controllers: [OrderEventController],
  providers: [OrderEventService],
})
export class OrderEventModule {}
