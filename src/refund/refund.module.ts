import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrderDeliveryEntity } from '../entity/order.delivery.entity';
import { RefundController } from './api/refund.controller';
import { RefundService } from './application/refund.service';

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([OrderDeliveryEntity])],
  controllers: [RefundController],
  providers: [RefundService],
})
export class RefundModule {}
