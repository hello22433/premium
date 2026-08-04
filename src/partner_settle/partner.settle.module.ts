import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PartnerDiscountHistoryEntity } from '../entity/partner.discount.history.entity';
import { PartnerDiscountScopeEntity } from '../entity/partner.discount.scope.entity';
import { PartnerDiscountPolicyEpochEntity } from '../entity/partner.discount.policy.epoch.entity';
import { PartnerDiscountHistoryService } from './application/partner.discount.history.service';
import { PartnerDiscountIntegrityService } from './application/partner.discount.integrity.service';
import { PartnerDiscountSeedService } from './application/partner.discount.seed.service';
import { UserDiscountEntity } from '../entity/user.discount.entity';

/**
 * 협력사 여신관리/정산확정 도메인.
 *
 * PR1A 범위는 정산조건 이력 스키마와 기록 훅뿐이다. 원장(partner_settle_ledger)·정산확정·여신 표는
 * 후속 PR 소유이며 여기에 없다.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      PartnerDiscountHistoryEntity,
      PartnerDiscountScopeEntity,
      PartnerDiscountPolicyEpochEntity,
      UserDiscountEntity,
    ]),
  ],
  providers: [PartnerDiscountHistoryService, PartnerDiscountIntegrityService, PartnerDiscountSeedService],
  exports: [PartnerDiscountHistoryService, PartnerDiscountIntegrityService, PartnerDiscountSeedService],
})
export class PartnerSettleModule {}
