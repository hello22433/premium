import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BankDepositEntity } from '../entity/bank.deposit.entity';
import { WalletAccountEntity } from '../entity/wallet.account.entity';
import { AuthModule } from '../auth/auth.module';
import { ActivityLogModule } from '../activity_log/activity.log.module';
import { DepositController } from './api/deposit.controller';
import { DepositService } from './application/deposit.service';
import { DepositSyncService } from './application/deposit.sync.service';
import { DepositSyncSchedule } from './application/deposit.sync.schedule';
import { DepositSourceHttp } from './infra/deposit.source.http';

@Module({
  // CryptoCipher 는 AuthModule 이, ActivityLogService 는 ActivityLogModule 이 export 한다.
  imports: [
    AuthModule,
    ActivityLogModule,
    HttpModule,
    TypeOrmModule.forFeature([BankDepositEntity, WalletAccountEntity]),
  ],
  controllers: [DepositController],
  providers: [DepositService, DepositSyncService, DepositSyncSchedule, DepositSourceHttp],
  exports: [DepositService, DepositSyncService],
})
export class DepositModule {}
