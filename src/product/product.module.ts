import { Module } from '@nestjs/common';
import { ProductEntity } from '../entity/product.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProductService } from './application/product.service';
import { ProductController } from './api/product.controller';
import { AuthModule } from '../auth/auth.module';
import { PartnerCompanyEntity } from '../entity/partner.company.entity';
import { BrandEntity } from '../entity/brand.entity';
import { ClassificationEntity } from '../entity/classification.entity';
import { ProductUpdateHistoryEntity } from '../entity/product.update.history.entity';
import { UserSyncProductEventEntity } from '../entity/user.sync.product.event.entity';
import { UserSyncProductEventMappingEntity } from '../entity/user.sync.product.event.mapping.entity';
import { ProductLikeEntity } from '../entity/product.like.entity';
import { SsgEventEntity } from '../entity/ssg.event.entity';
import { UserEntity } from 'src/entity/user.entity';
import { ActivityLogModule } from '../activity_log/activity.log.module';
import { FileModule } from '../file/file.module';
import { ProductSharedListFileEntity } from '../entity/product.shared.list.file.entity';
import { ProductChoiceMappingEntity } from '../entity/product.choice.mapping.entity';

@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([
      PartnerCompanyEntity,
      BrandEntity,
      ClassificationEntity,
      ProductEntity,
      ProductLikeEntity,
      ProductUpdateHistoryEntity,
      UserSyncProductEventEntity,
      UserSyncProductEventMappingEntity,
      SsgEventEntity,
      UserEntity,
      ProductSharedListFileEntity,
      ProductChoiceMappingEntity,
    ]),
    ActivityLogModule,
    FileModule,
  ],
  controllers: [ProductController],
  providers: [ProductService],
  exports: [ProductService],
})
export class ProductModule {}
