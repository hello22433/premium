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
import { ApiAppEntity } from '../entity/api.app.entity';
import { ApiCredentialEntity } from '../entity/api.credential.entity';
import { ApiCustomerMappingEntity } from '../entity/api.customer.mapping.entity';
import { WalletAccountEntity } from '../entity/wallet.account.entity';
import { WalletTransactionEntity } from '../entity/wallet.transaction.entity';
import { MailModule } from '../mail/mail.module';
import { ActivityLogModule } from '../activity_log/activity.log.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { SmsModule } from '../sms/sms.module';
import { WalletModule } from '../wallet/wallet.module';
import { AccountLifecycleModule } from '../account_lifecycle/account.lifecycle.module';
import { SettleModule } from '../settle/settle.module';
import { OrderFromModule } from '../order_from/order.from.module';

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
      ApiAppEntity,
      ApiCredentialEntity,
      ApiCustomerMappingEntity,
      WalletAccountEntity,
      WalletTransactionEntity,
    ]),
    MailModule,
    ActivityLogModule,
    forwardRef(() => DeliveryModule),
    SmsModule,
    WalletModule,
    AccountLifecycleModule,
    SettleModule,
    OrderFromModule,
  ],
  controllers: [UserManagementController],
  providers: [UserManagementService],
  exports: [UserManagementService],
})
export class UserManagementModule {}
