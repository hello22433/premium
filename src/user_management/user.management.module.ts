import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { UserManagementController } from './api/user.management.controller';
import { UserManagementService } from './application/user.management.service';
import { UserEntity } from '../entity/user.entity';
import { UserCompanyEntity } from '../entity/user.company.entity';
import { MailModule } from '../mail/mail.module';
import { ActivityLogModule } from '../activity_log/activity.log.module';

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([UserEntity, UserCompanyEntity]), MailModule, ActivityLogModule],
  controllers: [UserManagementController],
  providers: [UserManagementService],
  exports: [UserManagementService],
})
export class UserManagementModule {}
