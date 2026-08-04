import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BankDepositEntity } from '../entity/bank.deposit.entity';
import { UserEntity } from '../entity/user.entity';
import { AuthModule } from '../auth/auth.module';
import { DepositController } from './api/deposit.controller';
import { DepositService } from './application/deposit.service';

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([BankDepositEntity, UserEntity])],
  controllers: [DepositController],
  providers: [DepositService],
  exports: [DepositService],
})
export class DepositModule {}
