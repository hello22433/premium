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
import { GalaxiaBalanceInquiryStub, GiftShowBalanceInquiryStub } from './application/partner.balance.inquiry.stub';
import { PARTNER_BALANCE_INQUIRIES } from './application/partner.balance.inquiry.token';
import { PartnerSettleFeatureFlag } from './application/partner.settle.feature.flag';
import { PartnerSettleProducerService } from './application/partner.settle.producer.service';
import { UserDiscountEntity } from '../entity/user.discount.entity';
import { AuthModule } from '../auth/auth.module';
import { CreditConfigController } from './api/credit.config.controller';
import { CreditListController } from './api/credit.list.controller';
import { PartnerSettleReviewRecalculateService } from './application/partner.settle.review.recalculate.service';
import { PartnerSettleReviewAuditEntity } from '../entity/partner.settle.review.audit.entity';
import { PartnerSettleReviewResolutionEntity } from '../entity/partner.settle.review.resolution.entity';
import { PartnerProviderManualEventProposalEntity } from '../entity/partner.provider.manual.event.proposal.entity';
import { PartnerProviderManualLedgerProposalEntity } from '../entity/partner.provider.manual.ledger.proposal.entity';
import { PartnerSettleTransitionResolutionEntity } from '../entity/partner.settle.transition.resolution.entity';
import { OrderProductMappingEntity } from '../entity/order.product.mapping.entity';
import { PartnerSettleReviewResolutionService } from './application/partner.settle.review.resolution.service';
import { ReviewResolutionController } from './api/review.resolution.controller';
import { ReviewRecalculateController } from './api/review.recalculate.controller';
import { ReviewQueryController } from './api/review.query.controller';
import { ManualLedgerProposalController } from './api/manual.ledger.proposal.controller';
import { PartnerProviderManualLedgerService } from './application/partner.provider.manual.ledger.service';
import { PartnerSettleReviewQueryService } from './application/partner.settle.review.query.service';
import { PartnerSettleTransitionResolutionService } from './application/partner.settle.transition.resolution.service';
import { TransitionResolutionController } from './api/transition.resolution.controller';
import { BatchController } from './api/batch.controller';
import { PartnerSettleBatchService } from './application/partner.settle.batch.service';
import { PartnerSettlePaymentService } from './application/partner.settle.payment.service';
import { PartnerSettleBatchEntity } from '../entity/partner.settle.batch.entity';
import { PartnerSettleBatchReleaseEntity } from '../entity/partner.settle.batch.release.entity';
import { PartnerSettleBatchReleaseRequestEntity } from '../entity/partner.settle.batch.release.request.entity';
import { PartnerSettleExclusionEntity } from '../entity/partner.settle.exclusion.entity';
import { PartnerSettleConfigEntity } from '../entity/partner.settle.config.entity';
import { PartnerSettleCancelReconEntity } from '../entity/partner.settle.cancel.recon.entity';
import { PartnerSettlePaymentRequestEntity } from '../entity/partner.settle.payment.request.entity';
import { PartnerSettlePaymentVarianceProposalEntity } from '../entity/partner.settle.payment.variance.proposal.entity';
import { ActivityLogModule } from '../activity_log/activity.log.module';
import { PaymentVarianceController } from './api/payment.variance.controller';
import { PartnerSettlePaymentVarianceService } from './application/partner.settle.payment.variance.service';
import { PartnerDiscountReservationEntity } from '../entity/partner.discount.reservation.entity';
import { DiscountReservationController } from './api/discount.reservation.controller';
import { PartnerDiscountReservationService } from './application/partner.discount.reservation.service';
import { PartnerDiscountReservationSchedule } from './application/partner.discount.reservation.schedule';

/**
 * 협력사 여신관리/정산확정 도메인.
 *
 * PR1A 는 정산조건 이력 스키마와 기록 훅, PR1B 는 원장(partner_settle_ledger) append 경로다.
 * PR2 는 여신 표 조회(credit/list)와 여신 설정(credit/config)을 추가한다.
 * PR1C 는 NEEDS_REVIEW·orphan 해소 API 를 추가한다.
 * PR1D 는 정산확정(batch)·해제·지급 API 를 추가한다 — feature flag off 로 배포.
 * PR3A 는 지급 차이(PAYMENT_VARIANCE) 승인·반려를 추가한다 — paid flag 를 공유한다.
 * PR3B 는 정산조건 예약과 발효 cron 을 추가한다 — cron flag off 로 배포한다.
 */
@Module({
  imports: [
    AuthModule,
    ActivityLogModule,
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
      PartnerSettleReviewAuditEntity,
      PartnerSettleReviewResolutionEntity,
      PartnerProviderManualEventProposalEntity,
      PartnerProviderManualLedgerProposalEntity,
      PartnerSettleTransitionResolutionEntity,
      OrderProductMappingEntity,
      PartnerSettleBatchEntity,
      PartnerSettleBatchReleaseEntity,
      PartnerSettleBatchReleaseRequestEntity,
      PartnerSettleExclusionEntity,
      PartnerSettleConfigEntity,
      PartnerSettleCancelReconEntity,
      PartnerSettlePaymentRequestEntity,
      PartnerSettlePaymentVarianceProposalEntity,
      PartnerDiscountReservationEntity,
    ]),
  ],
  controllers: [
    CreditConfigController,
    CreditListController,
    ReviewRecalculateController,
    ReviewResolutionController,
    TransitionResolutionController,
    ManualLedgerProposalController,
    ReviewQueryController,
    BatchController,
    PaymentVarianceController,
    DiscountReservationController,
  ],
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
      useFactory: (giftShow: GiftShowBalanceInquiryStub, galaxia: GalaxiaBalanceInquiryStub) => [giftShow, galaxia],
      inject: [GiftShowBalanceInquiryStub, GalaxiaBalanceInquiryStub],
    },
    PartnerSettleFeatureFlag,
    PartnerSettleProducerService,
    PartnerSettleReviewRecalculateService,
    PartnerSettleReviewResolutionService,
    PartnerSettleTransitionResolutionService,
    PartnerProviderManualLedgerService,
    PartnerSettleReviewQueryService,
    PartnerSettleBatchService,
    PartnerSettlePaymentService,
    PartnerSettlePaymentVarianceService,
    PartnerDiscountReservationService,
    PartnerDiscountReservationSchedule,
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
    PartnerSettleReviewRecalculateService,
    PartnerSettleReviewResolutionService,
    PartnerSettleTransitionResolutionService,
    PartnerProviderManualLedgerService,
    PartnerSettleReviewQueryService,
    PartnerSettleBatchService,
    PartnerSettlePaymentService,
    PartnerSettlePaymentVarianceService,
    PartnerDiscountReservationService,
  ],
})
export class PartnerSettleModule {}
