import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { PartnerDiscountHistoryEntity } from '../../entity/partner.discount.history.entity';
import { PartnerDiscountPolicyEpochEntity } from '../../entity/partner.discount.policy.epoch.entity';
import {
  PartnerDiscountHistoryInterval,
  PricingOutcome,
  PricingProductSnapshot,
  resolvePricingAt,
} from '../domain/partner.settle.pricing';

/**
 * `occurredAt` 시점 매입율 판정의 적재 경로 (정본 §5.10 P10 · §8.2 · PR1B 명세 §3.5).
 *
 * 판정 자체는 순수함수 `resolvePricingAt` 이 하고, 여기서는 **잠금과 이력 적재만** 한다.
 *
 * `lockPolicyForRead()` 는 잠금 순서 1단계다. epoch 를 `FOR SHARE` 로 잡은 트랜잭션 안에서
 * 이력 재구성 → 원장 INSERT 까지 끝내야 한다. 이력 writer 는 같은 row 를 `FOR UPDATE` 로 잡으므로
 * S/X 충돌로 직렬화되고, reader 쪽 재검증이 필요 없다(REPEATABLE READ 에서 non-locking 재조회는
 * 첫 스냅샷에 고정되어 변경을 못 본다).
 */
@Injectable()
export class PartnerSettlePricingResolverService {
  constructor(
    @InjectRepository(PartnerDiscountPolicyEpochEntity)
    private readonly epochRepository: Repository<PartnerDiscountPolicyEpochEntity>,
    @InjectRepository(PartnerDiscountHistoryEntity)
    private readonly historyRepository: Repository<PartnerDiscountHistoryEntity>,
  ) {}

  /** 잠금 순서 1단계 — 협력사 정책 epoch `FOR SHARE`. 반드시 트랜잭션 안에서 부른다. */
  async lockPolicyForRead(partnerCompanyId: number): Promise<void> {
    // 정책 변경이 한 번도 없던 협력사는 epoch row 자체가 없다. 없으면 잠글 대상도 없으므로 만든다.
    await this.epochRepository.query(
      'INSERT IGNORE INTO partner_discount_policy_epoch (partner_company_id) VALUES (?)',
      [partnerCompanyId],
    );

    const locked = await this.epochRepository
      .createQueryBuilder('epoch')
      .setLock('pessimistic_read')
      .where('epoch.partnerCompanyId = :partnerCompanyId', { partnerCompanyId })
      .getOne();

    if (!locked) {
      throw new InternalServerErrorException('협력사 정산조건 정책 잠금에 실패했습니다.');
    }
  }

  /**
   * `occurredAt` 시점 이력 구간을 재구성해 매입율을 판정한다.
   *
   * `supersededByHistoryId` 가 채워진 row 는 경계 일치 소급으로 대체된 사본이라 timeline 에서 빠지고,
   * soft-delete 는 `@DeleteDateColumn` 이 자동 배제한다. tombstone(`DELETE`)은 "그 시각 비활성"이라는
   * 사실이므로 그대로 넘긴다 — 빼면 내부 hole 로 오판된다.
   */
  async resolveAt(
    partnerCompanyId: number,
    occurredAt: Date,
    snapshot: PricingProductSnapshot,
  ): Promise<PricingOutcome> {
    const rows = await this.historyRepository.find({
      where: { partnerCompanyId, supersededByHistoryId: IsNull() },
    });

    return resolvePricingAt(occurredAt, snapshot, rows.map(toInterval));
  }
}

function toInterval(row: PartnerDiscountHistoryEntity): PartnerDiscountHistoryInterval {
  return {
    id: row.id,
    scopeKey: row.scopeKey,
    category: row.category,
    classificationId: row.classificationId,
    method: row.method,
    primaryCategory: row.primaryCategory,
    group: row.group,
    range: row.range,
    compareCondition: row.compareCondition,
    changeType: row.changeType,
    pricePercent: row.pricePercent,
    priceAdjustment: row.priceAdjustment,
    validFrom: row.validFrom,
    validTo: row.validTo,
  };
}
