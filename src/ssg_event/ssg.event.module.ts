import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HttpModule } from '@nestjs/axios';
import { AuthModule } from '../auth/auth.module';
import { SsgIssue } from '../partner_company_extern/infra/ssg.issue';
import { SsgEventEntity } from '../entity/ssg.event.entity';
import { SsgEventController } from './api/ssg.event.controller';
import { SsgEventService } from './application/ssg.event.service';
import { SsgEventAmountHistoryEntity } from '../entity/ssg.event.amount.history.entity';
import { SsgEventRecoveryLogEntity } from '../entity/ssg.event.recovery.log.entity';
import { OrderDeliveryRefundEntity } from '../entity/order.delivery.refund.entity';
import { OrderDeliveryEntity } from '../entity/order.delivery.entity';
import { OrderProductMappingEntity } from '../entity/order.product.mapping.entity';
import { SsgReservationRangeEntity } from '../entity/ssg.reservation.range.entity';
import { ActivityLogModule } from '../activity_log/activity.log.module';

@Module({
  imports: [
    AuthModule,
    HttpModule.register({ timeout: 30000 }),
    TypeOrmModule.forFeature([
      OrderProductMappingEntity,
      OrderDeliveryEntity,
      SsgEventEntity,
      SsgEventAmountHistoryEntity,
      SsgEventRecoveryLogEntity,
      OrderDeliveryRefundEntity,
      SsgReservationRangeEntity,
    ]),
    ActivityLogModule,
  ],
  controllers: [SsgEventController],
  providers: [SsgEventService, { provide: 'ISsgIssue', useClass: SsgIssue }],
  exports: [SsgEventService],
})
export class SsgEventModule {}
