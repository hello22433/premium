import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OrderReceiptEntity } from '../entity/order.receipt.entity';
import { UserEntity } from '../entity/user.entity';
import { ProductEntity } from '../entity/product.entity';
import { OrderReceiptGeneratedOrderEntity } from '../entity/order.receipt.generated.order.entity';
import { OrderReceiptAutoResultEntity } from '../entity/order.receipt.auto.result.entity';
import { OrderFromDefinitionEntity } from '../entity/order.from.definition.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrderReceiptService } from './application/order.receipt.service';
import { OrderReceiptController } from './api/order.receipt.controller';
import { FileModule } from '../file/file.module';
import { ForbiddenWordModule } from '../forbidden_word/forbidden.word.module';
import { OrderModule } from '../order/order.module';
import { SsgEventModule } from '../ssg_event/ssg.event.module';
import { ProductModule } from '../product/product.module';
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
      OrderReceiptGeneratedOrderEntity,
      OrderReceiptAutoResultEntity,
      OrderFromDefinitionEntity,
    ]),
    FileModule,
    ForbiddenWordModule,
    OrderModule,
    SsgEventModule,
    ProductModule, // SSG 상품 액면가 확보(findSsgProductByPriceOrNull / findOrCreateSsgProductByPrice)
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
