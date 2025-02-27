import { Module } from '@nestjs/common';
import { UserController } from './api/user.controller';
import { UserService } from './application/user.service';
import { AuthModule } from '../auth/auth.module';
import { UserEntity } from '../entity/user.entity';
import { EmailSendHistoryEntity } from '../entity/email.send.history.entity';
import { MailModule } from '../mail/mail.module';
import { TypeOrmModule } from '@nestjs/typeorm';

@Module({
  imports: [AuthModule, MailModule, TypeOrmModule.forFeature([UserEntity, EmailSendHistoryEntity])],
  controllers: [UserController],
  providers: [UserService],
})
export class UserModule {}
