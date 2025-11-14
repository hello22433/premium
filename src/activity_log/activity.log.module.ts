import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ActivityLogEntity } from '../entity/activity.log.entity';
import { UserEntity } from '../entity/user.entity';
import { ActivityLogService } from './application/activity.log.service';
import { ActivityLogController } from './api/activity.log.controller';
import { PasswordBcryptEncrypt } from '../auth/infrastructure/password.bcrypt.encrypt';
import { DownloadExceptionFilter } from './api/download.exception.filter';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([ActivityLogEntity, UserEntity])],
  controllers: [ActivityLogController],
  providers: [ActivityLogService, PasswordBcryptEncrypt, DownloadExceptionFilter],
  exports: [ActivityLogService, DownloadExceptionFilter],
})
export class ActivityLogModule {}
