import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity } from '../entity/user.entity';
import { UserFindController } from './api/user.find.controller';
import { UserFindService } from './application/user.find.service';
import { EmailSendHistoryEntity } from '../entity/email.send.history.entity';
import { AuthModule } from '../auth/auth.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { SmsModule } from '../sms/sms.module';

@Module({
  imports: [
    AuthModule,
    MailModule,
    DeliveryModule,
    SmsModule,
    TypeOrmModule.forFeature([UserEntity, EmailSendHistoryEntity]),
  ],
  controllers: [UserFindController],
  providers: [UserFindService],
})
export class UserFindModule {}
