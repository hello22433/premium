import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrderEntity } from '../entity/order.entity';
import { SettleService } from './application/settle.service';
import { SettleController } from './api/settle.controller';
import { SettleUserController } from './api/settle.user.controller';
import { OtherServiceSaleEntity } from '../entity/other.service.sale.entity';
import { OtherServiceSaleProductEntity } from '../entity/other.service.sale.product.entity';
import { OtherServiceSaleProductMappingEntity } from '../entity/other.service.sale.product.mapping.entity';
import { ShippingStorageEntity } from '../entity/shipping.storage.entity';
import { OtherServiceSaleTypeEntity } from '../entity/other.service.sale.type.entity';
import { UserEntity } from '../entity/user.entity';
import { UserDiscountEntity } from '../entity/user.discount.entity';
import { OrderDeliveryEntity } from '../entity/order.delivery.entity';
import { SettleSchedule } from './settle.schedule';
import { ActivityLogModule } from '../activity_log/activity.log.module';
import { GalaxiaBarcodeLogEntity } from '../entity/galaxia.barcode.log.entity';
import { ActivityLogEntity } from '../entity/activity.log.entity';
import { WalletModule } from '../wallet/wallet.module';

@Module({
  imports: [
    AuthModule,
    ActivityLogModule,
    WalletModule,
    TypeOrmModule.forFeature([
      OrderEntity,
      OrderDeliveryEntity,
      OtherServiceSaleEntity,
      OtherServiceSaleProductEntity,
      OtherServiceSaleProductMappingEntity,
      OtherServiceSaleTypeEntity,
      ShippingStorageEntity,
      UserDiscountEntity,
      UserEntity,
      GalaxiaBarcodeLogEntity,
      ActivityLogEntity,
    ]),
  ],
  providers: [SettleService, SettleSchedule],
  controllers: [SettleController, SettleUserController],
  exports: [SettleService],
})
export class SettleModule {}
