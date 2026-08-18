import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InventoryCouponProductConfigEntity } from '../entity/inventory.coupon.product.config.entity';
import { InventoryPinImportBatchEntity } from '../entity/inventory.pin.import.batch.entity';
import { InventoryPinImportErrorEntity } from '../entity/inventory.pin.import.error.entity';
import { InventoryPinItemEntity } from '../entity/inventory.pin.item.entity';
import { InventoryPinEmailAttemptEntity } from '../entity/inventory.pin.email.attempt.entity';
import { InventoryPinEmailOutboxEntity } from '../entity/inventory.pin.email.outbox.entity';
import { InventoryPinBillingChainEntity } from '../entity/inventory.pin.billing.chain.entity';
import { InventoryPinReissueEntity } from '../entity/inventory.pin.reissue.entity';
import { PinInventoryPolicyEntity } from '../entity/pin.inventory.policy.entity';
import { DirectPinDeliveryPolicyEntity } from '../entity/direct.pin.delivery.policy.entity';
import { ExternalApiPinInventoryRequestEntity } from '../entity/external.api.pin.inventory.request.entity';
import { OrderDeliveryEntity } from '../entity/order.delivery.entity';
import { OrderProductMappingEntity } from '../entity/order.product.mapping.entity';
import { OrderDeliveryRefundEntity } from '../entity/order.delivery.refund.entity';
import { ApiAppEntity } from '../entity/api.app.entity';
import { ExternalApiAccountEntity } from '../entity/external.api.account.entity';
import { ApiCredentialEntity } from '../entity/api.credential.entity';
import { InventoryPinCryptoService } from './application/inventory.pin.crypto.service';
import { InventoryPinImportService } from './application/inventory.pin.import.service';
import { InventoryPinExcelParser } from './application/inventory.pin.excel.parser';
import { InventoryPinAllocationService } from './application/inventory.pin.allocation.service';
import { InventoryPinBillingChainService } from './application/inventory.pin.billing.chain.service';
import { InventoryPinConfigService } from './application/inventory.pin.config.service';
import { InventoryPinStockService } from './application/inventory.pin.stock.service';
import { InventoryPinPolicyService } from './application/inventory.pin.policy.service';
import { InventoryPinSendService } from './application/inventory.pin.send.service';
import { InventoryPinCsService } from './application/inventory.pin.cs.service';
import { InventoryPinCsViewService } from './application/inventory.pin.cs.view.service';
import { InventoryPinExternalService } from './application/inventory.pin.external.service';
import { DirectPinMailSender } from './application/direct.pin.mail.sender';
import { InventoryPinAdminController } from './api/inventory.pin.admin.controller';
import { InventoryPinConfigController } from './api/inventory.pin.config.controller';
import { InventoryPinCsController } from './api/inventory.pin.cs.controller';
import { InventoryPinExternalController } from './api/inventory.pin.external.controller';
import { InventoryPinRequestController } from './api/inventory.pin.request.controller';
import { InventoryPinRequestService } from './application/inventory.pin.request.service';
import { InventoryPinSendPolicyController } from './api/inventory.pin.send.policy.controller';
import { CryptoCipher } from '../common/infra/crypto.cipher';
import { MailModule } from '../mail/mail.module';
import { AuthModule } from '../auth/auth.module';
import { ExternalApiModule } from '../external_api/external.api.module';
import { AccountLifecycleModule } from '../account_lifecycle/account.lifecycle.module';
import { WalletModule } from '../wallet/wallet.module';
import { InventoryPinOutboxSchedule } from './inventory.pin.outbox.schedule';
@Module({
  imports: [
    TypeOrmModule.forFeature([
      InventoryCouponProductConfigEntity,
      InventoryPinImportBatchEntity,
      InventoryPinImportErrorEntity,
      InventoryPinItemEntity,
      InventoryPinEmailAttemptEntity,
      InventoryPinEmailOutboxEntity,
      InventoryPinBillingChainEntity,
      InventoryPinReissueEntity,
      PinInventoryPolicyEntity,
      DirectPinDeliveryPolicyEntity,
      ExternalApiPinInventoryRequestEntity,
      OrderDeliveryEntity,
      OrderProductMappingEntity,
      OrderDeliveryRefundEntity,
      ApiAppEntity,
      // ApiKeyGuard 는 @UseGuards(ApiKeyGuard) 로 이 모듈 컨텍스트에서 인스턴스화된다.
      // ExternalApiModule 이 export 해도 의존성은 호스트 모듈에서 해결되므로 여기에 등록 필요.
      ExternalApiAccountEntity,
      ApiCredentialEntity,
    ]),
    MailModule,
    AuthModule,
    AccountLifecycleModule,
    forwardRef(() => ExternalApiModule),
    forwardRef(() => WalletModule),
  ],
  controllers: [
    InventoryPinAdminController,
    InventoryPinConfigController,
    InventoryPinCsController,
    InventoryPinExternalController,
    InventoryPinRequestController,
    InventoryPinSendPolicyController,
  ],
  providers: [
    InventoryPinCryptoService,
    InventoryPinImportService,
    InventoryPinExcelParser,
    InventoryPinAllocationService,
    InventoryPinBillingChainService,
    InventoryPinConfigService,
    InventoryPinStockService,
    InventoryPinPolicyService,
    InventoryPinSendService,
    InventoryPinCsService,
    InventoryPinCsViewService,
    InventoryPinExternalService,
    DirectPinMailSender,
    InventoryPinRequestService,
    CryptoCipher,
    InventoryPinOutboxSchedule,
  ],
  exports: [
    InventoryPinAllocationService,
    InventoryPinBillingChainService,
    InventoryPinCryptoService,
    InventoryPinPolicyService,
    InventoryPinStockService,
    InventoryPinSendService,
    InventoryPinCsViewService,
  ],
})
export class InventoryCouponModule {}
