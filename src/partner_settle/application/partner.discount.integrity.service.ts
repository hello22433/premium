import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { PartnerDiscountHistoryEntity } from '../../entity/partner.discount.history.entity';
import { UserDiscountEntity } from '../../entity/user.discount.entity';
import { IPartnerDiscountChangeType } from '../interface/partner.discount.change.type';
import { buildPolicyTargetKey, buildScopeKey } from '../domain/discount.scope.key';

export type PartnerDiscountIntegrityViolation = {
  check: string;
  scopeKey: string | null;
  detail: string;
};

export type PartnerDiscountIntegrityReport = {
  checkedAt: Date;
  violations: PartnerDiscountIntegrityViolation[];
};

/**
 * 협력사 정산조건 이력 무결성 검사.
 *
 * **검출·보고만 하고 데이터를 고치지 않는다.** 이력이 깨진 scope 는 후속 PR 의 원장 계산에서
 * `NEEDS_REVIEW` 로 격리되어야 하며, 여기서 조용히 보정하면 잘못된 정산금액이 그대로 확정된다.
 *
 * `UNIQUE(open_key)` 가 이미 open 구간 1개를 강제하지만, 이 검사는 제약 도입 이전 데이터와
 * 수동 DB 조작을 잡기 위한 이중 방어다.
 */
@Injectable()
export class PartnerDiscountIntegrityService {
  private readonly logger = new Logger(PartnerDiscountIntegrityService.name);

  constructor(
    @InjectRepository(PartnerDiscountHistoryEntity)
    private historyRepository: Repository<PartnerDiscountHistoryEntity>,
    @InjectRepository(UserDiscountEntity)
    private userDiscountRepository: Repository<UserDiscountEntity>,
  ) {}

  async check(): Promise<PartnerDiscountIntegrityReport> {
    const violations: PartnerDiscountIntegrityViolation[] = [
      ...(await this.checkOverlap()),
      ...(await this.checkHole()),
      ...(await this.checkOpenIntervalCount()),
      ...(await this.checkUserDiscountScopeXor()),
      ...(await this.checkMissingSeed()),
      ...(await this.checkConflictingAdjustment()),
    ];

    if (violations.length > 0) {
      this.logger.error(`협력사 정산조건 이력 무결성 위반 ${violations.length}건`);
    }

    return { checkedAt: new Date(), violations };
  }

  /** 같은 scope 의 활성 구간이 겹치면 occurredAt 시점 값이 비결정이 된다. */
  private async checkOverlap(): Promise<PartnerDiscountIntegrityViolation[]> {
    const rows: { scope_key: string; a_id: number; b_id: number }[] = await this.historyRepository.query(`
      SELECT a.scope_key, a.id AS a_id, b.id AS b_id
        FROM partner_discount_history a
        JOIN partner_discount_history b
          ON a.scope_key = b.scope_key AND a.id < b.id
       WHERE a.deleted_at IS NULL AND b.deleted_at IS NULL
         AND a.superseded_by_history_id IS NULL AND b.superseded_by_history_id IS NULL
         AND a.valid_from < IFNULL(b.valid_to, '9999-12-31 23:59:59.999999')
         AND b.valid_from < IFNULL(a.valid_to, '9999-12-31 23:59:59.999999')
    `);

    return rows.map((row) => ({
      check: 'OVERLAP',
      scopeKey: row.scope_key,
      detail: `구간 겹침: history ${row.a_id} ↔ ${row.b_id}`,
    }));
  }

  /**
   * 마감된 구간의 종료 시각에 이어지는 구간이 없으면 내부 hole 이다.
   * close-and-insert / tombstone 절차를 지키면 나올 수 없는 상태라 이력 손상의 양의 증거다.
   */
  private async checkHole(): Promise<PartnerDiscountIntegrityViolation[]> {
    const rows: { scope_key: string; id: number; valid_to: string }[] = await this.historyRepository.query(`
      SELECT h.scope_key, h.id, h.valid_to
        FROM partner_discount_history h
        LEFT JOIN partner_discount_history n
          ON n.scope_key = h.scope_key
         AND n.valid_from = h.valid_to
         AND n.deleted_at IS NULL
         AND n.superseded_by_history_id IS NULL
       WHERE h.deleted_at IS NULL
         AND h.superseded_by_history_id IS NULL
         AND h.valid_to IS NOT NULL
         AND n.id IS NULL
    `);

    return rows.map((row) => ({
      check: 'HOLE',
      scopeKey: row.scope_key,
      detail: `history ${row.id} 의 종료(${row.valid_to}) 이후를 잇는 구간이 없습니다.`,
    }));
  }

  /** 이력이 있는 scope 는 활성 open 구간이 정확히 1개여야 한다. */
  private async checkOpenIntervalCount(): Promise<PartnerDiscountIntegrityViolation[]> {
    const rows: { scope_key: string; open_count: number }[] = await this.historyRepository.query(`
      SELECT scope_key, SUM(valid_to IS NULL) AS open_count
        FROM partner_discount_history
       WHERE deleted_at IS NULL AND superseded_by_history_id IS NULL
       GROUP BY scope_key
      HAVING open_count <> 1
    `);

    return rows.map((row) => ({
      check: 'OPEN_INTERVAL_COUNT',
      scopeKey: row.scope_key,
      detail: `활성 open 구간이 ${row.open_count}개입니다(1개여야 함).`,
    }));
  }

  /** user scope 와 partner scope 가 섞인 row 는 이력 대상 판정 자체가 불가능하다. */
  private async checkUserDiscountScopeXor(): Promise<PartnerDiscountIntegrityViolation[]> {
    const rows: { id: number }[] = await this.userDiscountRepository.query(`
      SELECT id FROM user_discount
       WHERE (user_id IS NULL AND partner_company_id IS NULL)
          OR (user_id IS NOT NULL AND partner_company_id IS NOT NULL)
    `);

    return rows.map((row) => ({
      check: 'USER_DISCOUNT_SCOPE_XOR',
      scopeKey: null,
      detail: `user_discount ${row.id} 의 user/partner scope 가 배타적이지 않습니다.`,
    }));
  }

  /**
   * 활성 협력사 할인인데 이력이 하나도 없는 scope.
   * 원장은 이 상태를 「정당한 무매칭 0%」로 처리하므로 런타임에 감지되지 않는다 — seed 누락의 유일한 방어선이다.
   */
  private async checkMissingSeed(): Promise<PartnerDiscountIntegrityViolation[]> {
    const activePartnerDiscounts = await this.userDiscountRepository.find({
      where: { partnerCompanyId: Not(IsNull()), userId: IsNull() },
    });
    if (activePartnerDiscounts.length === 0) return [];

    const knownScopeKeys = new Set(
      (
        await this.historyRepository
          .createQueryBuilder('history')
          .select('DISTINCT history.scopeKey', 'scopeKey')
          .getRawMany<{ scopeKey: string }>()
      ).map((row) => row.scopeKey),
    );

    return activePartnerDiscounts
      .map((discount) => buildScopeKey(this.toScopeFields(discount)))
      .filter((scopeKey) => !knownScopeKeys.has(scopeKey))
      .map((scopeKey) => ({
        check: 'MISSING_SEED',
        scopeKey,
        detail: '활성 협력사 할인에 대응하는 이력이 없습니다.',
      }));
  }

  /**
   * 같은 정책 대상에 할인과 할증이 동시에 활성이면 matcher 가 예외를 던져 해당 이벤트가 격리된다.
   * 격리 자체는 안전하지만 원인은 데이터라 사전에 잡는다.
   */
  private async checkConflictingAdjustment(): Promise<PartnerDiscountIntegrityViolation[]> {
    const openIntervals = await this.historyRepository.find({
      where: { validTo: IsNull(), supersededByHistoryId: IsNull(), changeType: Not(IPartnerDiscountChangeType.DELETE) },
    });

    const byTarget = new Map<string, Set<string>>();
    for (const interval of openIntervals) {
      if (!interval.priceAdjustment) continue;
      const targetKey = buildPolicyTargetKey(this.toScopeFields(interval));
      const adjustments = byTarget.get(targetKey) ?? new Set<string>();
      adjustments.add(interval.priceAdjustment);
      byTarget.set(targetKey, adjustments);
    }

    return [...byTarget.entries()]
      .filter(([, adjustments]) => adjustments.size > 1)
      .map(([targetKey]) => ({
        check: 'CONFLICTING_ADJUSTMENT',
        scopeKey: targetKey,
        detail: '같은 정책 대상에 할인과 할증이 동시에 활성입니다.',
      }));
  }

  private toScopeFields(row: UserDiscountEntity | PartnerDiscountHistoryEntity) {
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
