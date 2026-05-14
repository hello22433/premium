import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrderDeliveryEntity } from '../entity/order.delivery.entity';
import { RefundController } from './api/refund.controller';
import { RefundService } from './application/refund.service';
import { ActivityLogModule } from '../activity_log/activity.log.module';

@Module({
  imports: [AuthModule, ActivityLogModule, TypeOrmModule.forFeature([OrderDeliveryEntity])],
  controllers: [RefundController],
  providers: [RefundService],
})
export class RefundModule {}
