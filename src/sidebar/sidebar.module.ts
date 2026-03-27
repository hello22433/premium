import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrderEntity } from '../entity/order.entity';
import { OrderReceiptEntity } from '../entity/order.receipt.entity';
import { QnaEntity } from '../entity/qna.entity';
import { SidebarController } from './api/sidebar.controller';
import { SidebarService } from './application/sidebar.service';

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([OrderEntity, OrderReceiptEntity, QnaEntity])],
  controllers: [SidebarController],
  providers: [SidebarService],
})
export class SidebarModule {}
