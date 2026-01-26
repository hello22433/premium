import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PopularProductEntity } from '../entity/popular.product.entity';
import { ProductEntity } from '../entity/product.entity';
import { PopularProductService } from './application/popular.product.service';
import { PopularProductController } from './api/popular.product.controller';
import { PopularProductSchedule } from './popular.product.schedule';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([PopularProductEntity, ProductEntity]),
  ],
  controllers: [PopularProductController],
  providers: [PopularProductService, PopularProductSchedule],
  exports: [PopularProductService],
})
export class PopularProductModule {}