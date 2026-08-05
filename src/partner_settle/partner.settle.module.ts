import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PartnerDiscountHistoryEntity } from '../entity/partner.discount.history.entity';
import { PartnerDiscountScopeEntity } from '../entity/partner.discount.scope.entity';
import { PartnerDiscountPolicyEpochEntity } from '../entity/partner.discount.policy.epoch.entity';
import { PartnerSettleLedgerEntity } from '../entity/partner.settle.ledger.entity';
import { PartnerProviderEventInboxEntity } from '../entity/partner.provider.event.inbox.entity';
import { PartnerSettleTransitionObservationEntity } from '../entity/partner.settle.transition.observation.entity';
import { PartnerDiscountHistoryService } from './application/partner.discount.history.service';
import { PartnerDiscountIntegrityService } from './application/partner.discount.integrity.service';
import { PartnerDiscountSeedService } from './application/partner.discount.seed.service';
import { PartnerSettleLedgerService } from './application/partner.settle.ledger.service';
import { PartnerSettlePricingResolverService } from './application/partner.settle.pricing.resolver.service';
import { PartnerProviderEventInboxService } from './application/partner.provider.event.inbox.service';
import { PartnerSettleObservationService } from './application/partner.settle.observation.service';
import { UserDiscountEntity } from '../entity/user.discount.entity';

/**
 * 협력사 여신관리/정산확정 도메인.
 *
 * PR1A 는 정산조건 이력 스키마와 기록 훅, PR1B 는 원장(partner_settle_ledger) append 경로다.
 * 정산확정(batch)·여신 표·수동 승인 API 는 후속 PR 소유이며 여기에 없다.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      PartnerDiscountHistoryEntity,
      PartnerDiscountScopeEntity,
      PartnerDiscountPolicyEpochEntity,
      PartnerSettleLedgerEntity,
      PartnerProviderEventInboxEntity,
      PartnerSettleTransitionObservationEntity,
      UserDiscountEntity,
    ]),
  ],
  providers: [
    PartnerDiscountHistoryService,
    PartnerDiscountIntegrityService,
    PartnerDiscountSeedService,
    PartnerSettlePricingResolverService,
    PartnerSettleLedgerService,
    PartnerSettleObservationService,
    PartnerProviderEventInboxService,
  ],
  exports: [
    PartnerDiscountHistoryService,
    PartnerDiscountIntegrityService,
    PartnerDiscountSeedService,
    PartnerSettlePricingResolverService,
    PartnerSettleLedgerService,
    PartnerSettleObservationService,
    PartnerProviderEventInboxService,
  ],
})
export class PartnerSettleModule {}
