import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OrderReceiptEntity } from '../entity/order.receipt.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrderReceiptService } from './application/order.receipt.service';
import { OrderReceiptController } from './api/order.receipt.controller';

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([OrderReceiptEntity])],
  controllers: [OrderReceiptController],
  providers: [OrderReceiptService],
})
export class OrderReceiptModule {}
