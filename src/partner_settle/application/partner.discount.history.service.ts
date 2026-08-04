import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { PartnerDiscountHistoryEntity } from '../../entity/partner.discount.history.entity';
import { PartnerDiscountScopeEntity } from '../../entity/partner.discount.scope.entity';
import { PartnerDiscountPolicyEpochEntity } from '../../entity/partner.discount.policy.epoch.entity';
import { IPartnerDiscountChangeType } from '../interface/partner.discount.change.type';
import { IPriceAdjustment } from '../../user_discount/interface/price.adjustment';
import { buildPolicyTargetKey, buildScopeKey, PartnerDiscountScopeFields } from '../domain/discount.scope.key';

/**
 * 협력사 정산조건 이력 기록.
 *
 * 호출자는 **반드시 트랜잭션 안**에서 `lockPolicy()` → 원본 `user_discount` 쓰기 → 이 서비스의 기록
 * → `bumpEpoch()` 순으로 부른다. 원본 쓰기와 이력 기록 중 하나만 성공하면
 * - 원본만 성공: 신규 할인이 이력상 존재하지 않아 원장이 0% 로 오계산
 * - 이력만 성공: 삭제된 할인이 이력상 활성으로 잔존
 * 이므로 한 트랜잭션이 아니면 안 된다.
 *
 * 잠금 순서는 전 경로 공통이다: epoch → policyTargetKey 앵커 → scopeKey 앵커 → history.
 * 순서가 갈리면 직접 CRUD 와 예약 cron 이 교차 데드락에 걸린다.
 */
@Injectable()
export class PartnerDiscountHistoryService {
  private readonly logger = new Logger(PartnerDiscountHistoryService.name);

  constructor(
    @InjectRepository(PartnerDiscountHistoryEntity)
    private historyRepository: Repository<PartnerDiscountHistoryEntity>,
    @InjectRepository(PartnerDiscountScopeEntity)
    private scopeRepository: Repository<PartnerDiscountScopeEntity>,
    @InjectRepository(PartnerDiscountPolicyEpochEntity)
    private epochRepository: Repository<PartnerDiscountPolicyEpochEntity>,
  ) {}

  /**
   * 정책 잠금 획득. 넓은 대상 → 좁은 대상 순서로만 잡는다.
   *
   * policyTargetKey 앵커가 없으면 같은 대상의 BULK 요청과 SECTION 요청이 서로 다른 scopeKey 앵커를
   * 잡고 둘 다 통과해, 현행 서비스의 BULK/SECTION 상호배제 검증이 무력화된다.
   */
  async lockPolicy(scope: PartnerDiscountScopeFields): Promise<void> {
    await this.lockEpoch(scope.partnerCompanyId);
    await this.lockAnchor(buildPolicyTargetKey(scope));
    await this.lockAnchor(buildScopeKey(scope));
  }

  /**
   * 이력 변경을 원장 생성 측에 알리는 카운터. 같은 트랜잭션 안에서 올린다.
   */
  async bumpEpoch(partnerCompanyId: number): Promise<void> {
    await this.epochRepository.increment({ partnerCompanyId }, 'epoch', 1);
  }

  /**
   * 할인 생성 → `CREATE` 구간 `[at, NULL)`.
   *
   * 삭제 후 재생성이면 열려 있던 tombstone 을 먼저 마감한다. 마감하지 않으면
   * `UNIQUE(open_key)` 위반으로 트랜잭션이 롤백된다.
   */
  async recordCreate(
    scope: PartnerDiscountScopeFields,
    value: { pricePercent: number; priceAdjustment: IPriceAdjustment },
    changedBy: number | null,
    at: Date,
  ): Promise<void> {
    const scopeKey = buildScopeKey(scope);

    const { effectiveAt } = await this.closeOpenInterval(scopeKey, at);

    await this.historyRepository.insert({
      ...this.toScopeColumns(scope),
      scopeKey,
      changeType: IPartnerDiscountChangeType.CREATE,
      pricePercent: value.pricePercent,
      priceAdjustment: value.priceAdjustment,
      validFrom: effectiveAt,
      validTo: null,
      changedBy,
      supersededByHistoryId: null,
    });
  }

  /**
   * 할인 삭제 → 현재 구간 마감 + `DELETE` tombstone `[at, NULL)`.
   *
   * tombstone 이 없으면 삭제 이후 시각의 원장이 삭제된 할인율을 계속 적용한다.
   */
  async recordDelete(scope: PartnerDiscountScopeFields, changedBy: number | null, at: Date): Promise<void> {
    const scopeKey = buildScopeKey(scope);

    const { effectiveAt, closed } = await this.closeOpenInterval(scopeKey, at);
    if (!closed) {
      // seed 이전에 만들어진 할인을 삭제하는 경우 열린 구간이 없다.
      // 사실(삭제)은 그대로 남기고, 과거 구간 복원은 seed 가 맡는다.
      this.logger.warn(`정산조건 삭제 시 열린 이력 구간이 없습니다. scopeKey=${scopeKey}`);
    }

    await this.historyRepository.insert({
      ...this.toScopeColumns(scope),
      scopeKey,
      changeType: IPartnerDiscountChangeType.DELETE,
      pricePercent: null,
      priceAdjustment: null,
      validFrom: effectiveAt,
      validTo: null,
      changedBy,
      supersededByHistoryId: null,
    });
  }

  /**
   * 열린 구간을 마감하고, 뒤이을 구간이 시작해야 할 **실효 시각**을 돌려준다.
   *
   * 마감 시각과 다음 구간 시작 시각은 반드시 같은 값이어야 한다. 다르면 두 구간이 겹치거나(overlap)
   * 사이에 hole 이 생겨 무결성 검사에 걸린다.
   *
   * 요청 시각이 열린 구간의 시작보다 앞서거나 같으면(같은 밀리초 안에서 생성 직후 삭제 등) 그대로 쓸 수 없다 —
   * `validFrom < validTo` CHECK 를 깨기 때문이다. 이때만 1ms 를 더해 순서를 보존한다.
   */
  private async closeOpenInterval(scopeKey: string, at: Date): Promise<{ effectiveAt: Date; closed: boolean }> {
    const open = await this.historyRepository
      .createQueryBuilder('history')
      .setLock('pessimistic_write')
      .where('history.scopeKey = :scopeKey', { scopeKey })
      .andWhere('history.validTo IS NULL')
      .andWhere('history.supersededByHistoryId IS NULL')
      .getOne();

    if (!open) return { effectiveAt: at, closed: false };

    const effectiveAt = open.validFrom >= at ? new Date(open.validFrom.getTime() + 1) : at;
    const result = await this.historyRepository.update(
      { id: open.id, validTo: IsNull() },
      { validTo: effectiveAt },
    );

    if (result.affected !== 1) {
      throw new InternalServerErrorException('정산조건 이력 구간 마감에 실패했습니다.');
    }
    return { effectiveAt, closed: true };
  }

  private async lockEpoch(partnerCompanyId: number): Promise<void> {
    await this.epochRepository.query(
      'INSERT IGNORE INTO partner_discount_policy_epoch (partner_company_id) VALUES (?)',
      [partnerCompanyId],
    );

    const locked = await this.epochRepository
      .createQueryBuilder('epoch')
      .setLock('pessimistic_write')
      .where('epoch.partnerCompanyId = :partnerCompanyId', { partnerCompanyId })
      .getOne();

    if (!locked) {
      throw new InternalServerErrorException('협력사 정산조건 정책 잠금에 실패했습니다.');
    }
  }

  /**
   * 값 없는 앵커 row 를 만들고 잠근다. history row 가 0개인 신규 scope 도 이 앵커로 직렬화된다.
   */
  private async lockAnchor(key: string): Promise<void> {
    await this.scopeRepository.query('INSERT IGNORE INTO partner_discount_scope (scope_key) VALUES (?)', [key]);

    const locked = await this.scopeRepository
      .createQueryBuilder('scope')
      .setLock('pessimistic_write')
      .where('scope.scopeKey = :key', { key })
      .getOne();

    if (!locked) {
      throw new InternalServerErrorException('협력사 정산조건 scope 잠금에 실패했습니다.');
    }
  }

  private toScopeColumns(scope: PartnerDiscountScopeFields) {
    return {
      partnerCompanyId: scope.partnerCompanyId,
      category: scope.category,
      classificationId: scope.classificationId ?? null,
      method: scope.method,
      primaryCategory: scope.primaryCategory ?? null,
      group: scope.group ?? null,
      range: scope.range ?? null,
      compareCondition: scope.compareCondition,
    };
  }
}
