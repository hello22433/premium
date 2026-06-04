import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { UserManagementController } from './api/user.management.controller';
import { UserManagementService } from './application/user.management.service';
import { UserEntity } from '../entity/user.entity';
import { UserCompanyEntity } from '../entity/user.company.entity';
import { UserViewScopeEntity } from '../entity/user.view.scope.entity';
import { DepartmentEntity } from '../entity/department.entity';
import { ExternalApiAccountEntity } from '../entity/external.api.account.entity';
import { ExternalApiAllowedIpEntity } from '../entity/external.api.allowed.ip.entity';
import { ExternalApiSsgRequestEntity } from '../entity/external.api.ssg.request.entity';
import { WalletAccountEntity } from '../entity/wallet.account.entity';
import { WalletTransactionEntity } from '../entity/wallet.transaction.entity';
import { MailModule } from '../mail/mail.module';
import { ActivityLogModule } from '../activity_log/activity.log.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { SmsModule } from '../sms/sms.module';

@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([
      UserEntity,
      UserCompanyEntity,
      UserViewScopeEntity,
      DepartmentEntity,
      ExternalApiAccountEntity,
      ExternalApiAllowedIpEntity,
      ExternalApiSsgRequestEntity,
      WalletAccountEntity,
      WalletTransactionEntity,
    ]),
    MailModule,
    ActivityLogModule,
    forwardRef(() => DeliveryModule),
    SmsModule,
  ],
  controllers: [UserManagementController],
  providers: [UserManagementService],
  exports: [UserManagementService],
})
export class UserManagementModule {}
