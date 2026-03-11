import { Module } from '@nestjs/common';
import { UserController } from './api/user.controller';
import { UserService } from './application/user.service';
import { AuthModule } from '../auth/auth.module';
import { UserEntity } from '../entity/user.entity';
import { UserCompanyEntity } from '../entity/user.company.entity';
import { UserViewScopeEntity } from '../entity/user.view.scope.entity';
import { PasswordPolicyEntity } from '../entity/password.policy.entity';
import { EmailSendHistoryEntity } from '../entity/email.send.history.entity';
import { MailModule } from '../mail/mail.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ActivityLogModule } from '../activity_log/activity.log.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { SmsModule } from '../sms/sms.module';

@Module({
  imports: [
    AuthModule,
    MailModule,
    DeliveryModule,
    SmsModule,
    TypeOrmModule.forFeature([UserEntity, UserCompanyEntity, UserViewScopeEntity, PasswordPolicyEntity, EmailSendHistoryEntity]),
    ActivityLogModule,
  ],
  controllers: [UserController],
  providers: [UserService],
})
export class UserModule {}
