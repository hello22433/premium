import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ActivityLogEntity } from '../entity/activity.log.entity';
import { UserEntity } from '../entity/user.entity';
import { ActivityLogService } from './application/activity.log.service';
import { PasswordBcryptEncrypt } from '../auth/infrastructure/password.bcrypt.encrypt';
import { DownloadExceptionFilter } from './api/download.exception.filter';

@Module({
  imports: [TypeOrmModule.forFeature([ActivityLogEntity, UserEntity])],
  providers: [ActivityLogService, PasswordBcryptEncrypt, DownloadExceptionFilter],
  exports: [ActivityLogService, DownloadExceptionFilter],
})
export class ActivityLogModule {}
