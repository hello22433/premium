import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { Transactional } from 'typeorm-transactional';
import { PartnerDiscountHistoryEntity } from '../../entity/partner.discount.history.entity';
import { UserDiscountEntity } from '../../entity/user.discount.entity';
import { buildScopeKey, PartnerDiscountScopeFields } from '../domain/discount.scope.key';
import {
  buildSeedIntervals,
  PartnerDiscountSeedBounds,
  PartnerDiscountSeedError,
} from '../domain/discount.history.seed';

export type PartnerDiscountSeedResult = {
  scopeCount: number;
  insertedIntervalCount: number;
  /** 이미 이력이 있어 건너뛴 scope. 훅이 먼저 기록한 scope 는 과거 구간이 복원되지 않으므로 확인이 필요하다. */
  skippedScopeKeys: string[];
  failures: { scopeKey: string; reason: string }[];
};

/**
 * 협력사 정산조건 이력 초기 seed.
 *
 * 대상은 `partnerCompanyId IS NOT NULL AND userId IS NULL` row 뿐이며, soft-delete 된 row 도 포함해
 * lifecycle 을 복원한다. 실행 후에는 cutoff 이전 occurredAt 도 항상 이력으로 결정되고
 * live `user_discount` 폴백이 사라진다(같은 이벤트에 항상 같은 금액).
 *
 * **dry-run 을 먼저 돌려 failures 가 0 인지 확인한 뒤 적용한다.** 판단 불가 입력은 근사하지 않고 실패로 남긴다.
 */
@Injectable()
export class PartnerDiscountSeedService {
  private readonly logger = new Logger(PartnerDiscountSeedService.name);

  constructor(
    @InjectRepository(PartnerDiscountHistoryEntity)
    private historyRepository: Repository<PartnerDiscountHistoryEntity>,
    @InjectRepository(UserDiscountEntity)
    private userDiscountRepository: Repository<UserDiscountEntity>,
  ) {}

  @Transactional()
  async seed(bounds: PartnerDiscountSeedBounds, options: { dryRun: boolean }): Promise<PartnerDiscountSeedResult> {
    const rows = await this.userDiscountRepository.find({
      where: { partnerCompanyId: Not(IsNull()), userId: IsNull() },
      withDeleted: true,
      order: { createdAt: 'ASC', id: 'ASC' },
    });

    const existingScopeKeys = new Set(
      (
        await this.historyRepository
          .createQueryBuilder('history')
          .select('DISTINCT history.scopeKey', 'scopeKey')
          .getRawMany<{ scopeKey: string }>()
      ).map((row) => row.scopeKey),
    );

    const byScope = new Map<string, { scope: PartnerDiscountScopeFields; discounts: UserDiscountEntity[] }>();
    for (const row of rows) {
      const scope = this.toScopeFields(row);
      const scopeKey = buildScopeKey(scope);
      const bucket = byScope.get(scopeKey) ?? { scope, discounts: [] };
      bucket.discounts.push(row);
      byScope.set(scopeKey, bucket);
    }

    const result: PartnerDiscountSeedResult = {
      scopeCount: byScope.size,
      insertedIntervalCount: 0,
      skippedScopeKeys: [],
      failures: [],
    };

    for (const [scopeKey, bucket] of byScope) {
      if (existingScopeKeys.has(scopeKey)) {
        // 훅이 먼저 기록한 scope 다. 덮어쓰면 훅 기록과 복원 구간이 겹친다.
        result.skippedScopeKeys.push(scopeKey);
        continue;
      }

      let intervals;
      try {
        intervals = buildSeedIntervals(
          bucket.discounts.map((discount) => ({
            id: discount.id,
            createdAt: discount.createdAt,
            deletedAt: discount.deletedAt,
            pricePercent: discount.pricePercent,
            priceAdjustment: discount.priceAdjustment,
          })),
          bounds,
        );
      } catch (error) {
        if (error instanceof PartnerDiscountSeedError) {
          result.failures.push({ scopeKey, reason: error.message });
          continue;
        }
        throw error;
      }

      result.insertedIntervalCount += intervals.length;

      if (options.dryRun) continue;

      for (const interval of intervals) {
        await this.historyRepository.insert({
          partnerCompanyId: bucket.scope.partnerCompanyId,
          category: bucket.scope.category,
          classificationId: bucket.scope.classificationId ?? null,
          method: bucket.scope.method,
          primaryCategory: bucket.scope.primaryCategory ?? null,
          group: bucket.scope.group ?? null,
          range: bucket.scope.range ?? null,
          compareCondition: bucket.scope.compareCondition,
          scopeKey,
          changeType: interval.changeType,
          pricePercent: interval.pricePercent,
          priceAdjustment: interval.priceAdjustment,
          validFrom: interval.validFrom,
          validTo: interval.validTo,
          changedBy: null,
          supersededByHistoryId: null,
        });
      }
    }

    if (result.failures.length > 0) {
      this.logger.error(`정산조건 seed 실패 scope ${result.failures.length}건 — 수동 확인 후 재실행이 필요합니다.`);
    }
    if (options.dryRun) {
      this.logger.log(`정산조건 seed dry-run: scope ${result.scopeCount} · 구간 ${result.insertedIntervalCount}`);
    }

    return result;
  }

  private toScopeFields(row: UserDiscountEntity): PartnerDiscountScopeFields {
    return {
      partnerCompanyId: row.partnerCompanyId!,
      category: row.category,
      classificationId: row.classificationId,
      method: row.method,
      primaryCategory: row.primaryCategory,
      group: row.group,
      range: row.range,
      compareCondition: row.compareCondition,
    };
  }
}
