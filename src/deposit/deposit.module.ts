import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BankDepositEntity } from '../entity/bank.deposit.entity';
import { UserEntity } from '../entity/user.entity';
import { AuthModule } from '../auth/auth.module';
import { DepositController } from './api/deposit.controller';
import { DepositService } from './application/deposit.service';
import { DepositSyncService } from './application/deposit.sync.service';
import { DepositSyncSchedule } from './application/deposit.sync.schedule';
import { DepositSourceHttp } from './infra/deposit.source.http';

@Module({
  imports: [AuthModule, HttpModule, TypeOrmModule.forFeature([BankDepositEntity, UserEntity])],
  controllers: [DepositController],
  providers: [DepositService, DepositSyncService, DepositSyncSchedule, DepositSourceHttp],
  exports: [DepositService, DepositSyncService],
})
export class DepositModule {}
