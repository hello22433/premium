import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OrderReceiptEntity } from '../entity/order.receipt.entity';
import { UserEntity } from '../entity/user.entity';
import { ProductEntity } from '../entity/product.entity';
import { SsgReservationRangeEntity } from '../entity/ssg.reservation.range.entity';
import { OrderReceiptGeneratedOrderEntity } from '../entity/order.receipt.generated.order.entity';
import { OrderReceiptAutoResultEntity } from '../entity/order.receipt.auto.result.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrderReceiptService } from './application/order.receipt.service';
import { OrderReceiptController } from './api/order.receipt.controller';
import { FileModule } from '../file/file.module';
import { ForbiddenWordModule } from '../forbidden_word/forbidden.word.module';
import { OrderModule } from '../order/order.module';
import { AutoOrderService } from './application/auto_order/auto.order.service';
import { AutoOrderExcelParser } from './application/auto_order/auto.order.excel.parser';
import { AutoOrderStructureValidator } from './application/auto_order/auto.order.structure.validator';
import { AutoOrderProductMapper } from './application/auto_order/auto.order.product.mapper';
import { AutoOrderPreValidator } from './application/auto_order/auto.order.pre.validator';
import { AutoOrderPayloadBuilder } from './application/auto_order/auto.order.payload.builder';

@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([
      OrderReceiptEntity,
      UserEntity,
      ProductEntity,
      SsgReservationRangeEntity,
      OrderReceiptGeneratedOrderEntity,
      OrderReceiptAutoResultEntity,
    ]),
    FileModule,
    ForbiddenWordModule,
    OrderModule,
  ],
  controllers: [OrderReceiptController],
  providers: [
    OrderReceiptService,
    AutoOrderService,
    AutoOrderExcelParser,
    AutoOrderStructureValidator,
    AutoOrderProductMapper,
    AutoOrderPreValidator,
    AutoOrderPayloadBuilder,
  ],
})
export class OrderReceiptModule {}
