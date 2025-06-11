import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { UserManagementController } from './api/user.management.controller';
import { UserManagementService } from './application/user.management.service';
import { UserEntity } from '../entity/user.entity';
import { MailModule } from '../mail/mail.module';

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([UserEntity]), MailModule],
  controllers: [UserManagementController],
  providers: [UserManagementService],
  exports: [UserManagementService],
})
export class UserManagementModule {}
