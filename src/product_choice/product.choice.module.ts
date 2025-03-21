import { Module } from '@nestjs/common';
import { ProductChoiceController } from './api/product.choice.controller';
import { ProductChoiceService } from './application/product.choice.service';
import { AuthModule } from '../auth/auth.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProductEntity } from '../entity/product.entity';
import { ProductUpdateHistoryEntity } from '../entity/product.update.history.entity';
import { ProductChoiceMappingEntity } from '../entity/product.choice.mapping.entity';

@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([ProductEntity, ProductChoiceMappingEntity, ProductUpdateHistoryEntity]),
  ],
  controllers: [ProductChoiceController],
  providers: [ProductChoiceService],
})
export class ProductChoiceModule {}
