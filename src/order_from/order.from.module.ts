import { Module } from '@nestjs/common';
import { OrderFromService } from './application/order.from.service';
import { OrderFromController } from './api/order.from.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrderFromDefinitionEntity } from '../entity/order.from.definition.entity';
import { AuthModule } from '../auth/auth.module';
import { MailModule } from '../mail/mail.module';

@Module({
  imports: [AuthModule, MailModule, TypeOrmModule.forFeature([OrderFromDefinitionEntity])],
  controllers: [OrderFromController],
  providers: [OrderFromService],
})
export class OrderFromModule {}
