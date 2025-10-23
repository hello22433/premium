import { Module } from '@nestjs/common';
import { ProductEntity } from '../entity/product.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProductService } from './application/product.service';
import { ProductController } from './api/product.controller';
import { AuthModule } from '../auth/auth.module';
import { PartnerCompanyEntity } from '../entity/partner.company.entity';
import { BrandEntity } from '../entity/brand.entity';
import { ProductUpdateHistoryEntity } from '../entity/product.update.history.entity';
import { UserSyncProductEventEntity } from '../entity/user.sync.product.event.entity';
import { ProductLikeEntity } from '../entity/product.like.entity';
import { SsgEventEntity } from '../entity/ssg.event.entity';
import { UserEntity } from 'src/entity/user.entity';

@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([
      PartnerCompanyEntity,
      BrandEntity,
      ProductEntity,
      ProductLikeEntity,
      ProductUpdateHistoryEntity,
      UserSyncProductEventEntity,
      SsgEventEntity,
      UserEntity,
    ]),
  ],
  controllers: [ProductController],
  providers: [ProductService],
})
export class ProductModule {}
