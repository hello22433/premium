import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserSyncProductEventEntity } from '../entity/user.sync.product.event.entity';
import { UserSyncProductController } from './api/user.sync.product.controller';
import { UserSyncProductService } from './application/user.sync.product.service';
import { UserSyncProductEventMappingEntity } from '../entity/user.sync.product.event.mapping.entity';
import { UserEntity } from '../entity/user.entity';
import { ProductEntity } from '../entity/product.entity';

@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([
      UserEntity,
      ProductEntity,
      UserSyncProductEventEntity,
      UserSyncProductEventMappingEntity,
    ]),
  ],
  controllers: [UserSyncProductController],
  providers: [UserSyncProductService],
})
export class UserSyncProductModule {}
