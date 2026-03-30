import { Module } from '@nestjs/common';
import { UserDiscountController } from './api/user.discount.controller';
import { UserDiscountService } from './application/user.discount.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { UserDiscountEntity } from '../entity/user.discount.entity';
import { UserEntity } from '../entity/user.entity';
import { ClassificationEntity } from '../entity/classification.entity';

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([UserDiscountEntity, UserEntity, ClassificationEntity])],
  controllers: [UserDiscountController],
  providers: [UserDiscountService],
})
export class UserDiscountModule {}
