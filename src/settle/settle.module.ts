import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrderEntity } from '../entity/order.entity';
import { SettleService } from './application/settle.service';
import { SettleController } from './api/settle.controller';
import { OtherServiceSaleEntity } from '../entity/other.service.sale.entity';
import { OtherServiceSaleProductEntity } from '../entity/other.service.sale.product.entity';
import { OtherServiceSaleProductMappingEntity } from '../entity/other.service.sale.product.mapping.entity';
import { ShippingStorageEntity } from '../entity/shipping.storage.entity';
import { OtherServiceSaleTypeEntity } from '../entity/other.service.sale.type.entity';
import { UserEntity } from '../entity/user.entity';

@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([
      OrderEntity,
      OtherServiceSaleEntity,
      OtherServiceSaleProductEntity,
      OtherServiceSaleProductMappingEntity,
      OtherServiceSaleTypeEntity,
      ShippingStorageEntity,
      UserEntity,
    ]),
  ],
  providers: [SettleService],
  controllers: [SettleController],
})
export class SettleModule {}
