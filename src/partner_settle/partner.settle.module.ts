import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PartnerDiscountHistoryEntity } from '../entity/partner.discount.history.entity';
import { PartnerDiscountScopeEntity } from '../entity/partner.discount.scope.entity';
import { PartnerDiscountPolicyEpochEntity } from '../entity/partner.discount.policy.epoch.entity';
import { PartnerSettleLedgerEntity } from '../entity/partner.settle.ledger.entity';
import { PartnerProviderEventInboxEntity } from '../entity/partner.provider.event.inbox.entity';
import { PartnerSettleTransitionObservationEntity } from '../entity/partner.settle.transition.observation.entity';
import { PartnerCreditConfigEntity } from '../entity/partner.credit.config.entity';
import { PartnerCreditConfigHistoryEntity } from '../entity/partner.credit.config.history.entity';
import { PartnerCompanyEntity } from '../entity/partner.company.entity';
import { SsgEventEntity } from '../entity/ssg.event.entity';
import { PartnerDiscountHistoryService } from './application/partner.discount.history.service';
import { PartnerDiscountIntegrityService } from './application/partner.discount.integrity.service';
import { PartnerDiscountSeedService } from './application/partner.discount.seed.service';
import { PartnerSettleLedgerService } from './application/partner.settle.ledger.service';
import { PartnerSettlePricingResolverService } from './application/partner.settle.pricing.resolver.service';
import { PartnerProviderEventInboxService } from './application/partner.provider.event.inbox.service';
import { PartnerSettleObservationService } from './application/partner.settle.observation.service';
import { PartnerCreditConfigService } from './application/partner.credit.config.service';
import { PartnerCreditListService } from './application/partner.credit.list.service';
import { CreditFeatureFlag } from './application/credit.feature.flag';
import {
  GalaxiaBalanceInquiryStub,
  GiftShowBalanceInquiryStub,
} from './application/partner.balance.inquiry.stub';
import { PARTNER_BALANCE_INQUIRIES } from './application/partner.balance.inquiry.token';
import { PartnerSettleFeatureFlag } from './application/partner.settle.feature.flag';
import { PartnerSettleProducerService } from './application/partner.settle.producer.service';
import { UserDiscountEntity } from '../entity/user.discount.entity';
import { AuthModule } from '../auth/auth.module';
import { CreditConfigController } from './api/credit.config.controller';
import { CreditListController } from './api/credit.list.controller';

/**
 * 협력사 여신관리/정산확정 도메인.
 *
 * PR1A 는 정산조건 이력 스키마와 기록 훅, PR1B 는 원장(partner_settle_ledger) append 경로다.
 * PR2 는 여신 표 조회(credit/list)와 여신 설정(credit/config)을 추가한다 — 원장은 읽기 전용이며
 * 여신 API 는 feature flag(`SETTLE_CREDIT_API_ENABLED`) off 로 배포된다(§15.2).
 * 정산확정(batch)·수동 승인 API 는 후속 PR 소유이며 여기에 없다.
 */
@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([
      PartnerDiscountHistoryEntity,
      PartnerDiscountScopeEntity,
      PartnerDiscountPolicyEpochEntity,
      PartnerSettleLedgerEntity,
      PartnerProviderEventInboxEntity,
      PartnerSettleTransitionObservationEntity,
      PartnerCreditConfigEntity,
      PartnerCreditConfigHistoryEntity,
      PartnerCompanyEntity,
      SsgEventEntity,
      UserDiscountEntity,
    ]),
  ],
  controllers: [CreditConfigController, CreditListController],
  providers: [
    PartnerDiscountHistoryService,
    PartnerDiscountIntegrityService,
    PartnerDiscountSeedService,
    PartnerSettlePricingResolverService,
    PartnerSettleLedgerService,
    PartnerSettleObservationService,
    PartnerProviderEventInboxService,
    PartnerCreditConfigService,
    PartnerCreditListService,
    CreditFeatureFlag,
    GiftShowBalanceInquiryStub,
    GalaxiaBalanceInquiryStub,
    {
      provide: PARTNER_BALANCE_INQUIRIES,
      useFactory: (giftShow: GiftShowBalanceInquiryStub, galaxia: GalaxiaBalanceInquiryStub) => [
        giftShow,
        galaxia,
      ],
      inject: [GiftShowBalanceInquiryStub, GalaxiaBalanceInquiryStub],
    },
    PartnerSettleFeatureFlag,
    PartnerSettleProducerService,
  ],
  exports: [
    PartnerDiscountHistoryService,
    PartnerDiscountIntegrityService,
    PartnerDiscountSeedService,
    PartnerSettlePricingResolverService,
    PartnerSettleLedgerService,
    PartnerSettleObservationService,
    PartnerProviderEventInboxService,
    PartnerCreditConfigService,
    PartnerCreditListService,
    PartnerSettleFeatureFlag,
    PartnerSettleProducerService,
  ],
})
export class PartnerSettleModule {}
