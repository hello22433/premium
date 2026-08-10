import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Transactional } from 'typeorm-transactional';
import { PartnerDiscountHistoryEntity } from '../../entity/partner.discount.history.entity';
import { PartnerDiscountReservationEntity } from '../../entity/partner.discount.reservation.entity';
import { UserDiscountEntity } from '../../entity/user.discount.entity';
import { IPartnerDiscountChangeType } from '../interface/partner.discount.change.type';
import {
  IPartnerDiscountReservationFailureCode,
  IPartnerDiscountReservationStatus,
} from '../interface/partner.discount.reservation.status';
import {
  ActiveInterval,
  findTimelineViolation,
  planIntervalSplit,
  PlannedInsert,
} from '../domain/discount.interval.split';
import {
  buildPolicyTargetKey,
  buildScopeKey,
  normalizeScopeRange,
  PartnerDiscountScopeFields,
} from '../domain/discount.scope.key';
import { computePayloadHash } from '../domain/proposal.hash';
import { retryOnLockConflict } from '../domain/lock.retry';
import { PartnerDiscountHistoryService } from './partner.discount.history.service';
import { PartnerSettleRepriceService } from './partner.settle.reprice.service';
import { PartnerSettleFeatureFlag } from './partner.settle.feature.flag';
import { ReservationCreateReqDto, ReservationQueryDto } from '../api/dto/discount.reservation.dto';

const PAYLOAD_HASH_VERSION = 'v1';

/** 발효 1건의 결과. cron 로그·테스트가 읽는다. */
export type ReservationApplyOutcome = {
  reservationId: number;
  status: IPartnerDiscountReservationStatus;
  resultHistoryId: number | null;
  failureCode: IPartnerDiscountReservationFailureCode | null;
};

/** 활성 timeline 불변식 위반. 트랜잭션을 롤백시키기 위한 내부 신호다. */
export class IntervalInvariantError extends Error {}

/** scope 필드를 가진 모든 입력(요청 DTO · 예약 row · history row)의 공통 형태. */
type ScopeCarrier = Pick<
  PartnerDiscountReservationEntity,
  'partnerCompanyId' | 'category' | 'method' | 'compareCondition'
> & {
  classificationId?: number | null;
  primaryCategory?: string | null;
  group?: string | null;
  range?: string | null;
};

/**
 * 협력사 정산조건 예약 (정본 §5.6 · §8.3 · §8.6 · PR3B).
 *
 * 예약 등록은 아무 것도 발효하지 않는다. cron 이 `effectiveAt` 을 지난 PENDING 을 집어
 * `partner_discount_history` 구간을 만들면서 APPLIED 로 넘긴다.
 *
 * 설계상 지켜야 할 규칙 넷:
 * 1. **잠금은 PR1A 의 `lockPolicy()` 를 그대로 쓴다** — epoch → policyTargetKey → scopeKey 순.
 *    예약 경로만 다른 순서로 잡으면 직접 CRUD 와 교차 데드락에 걸린다. 그래서 트랜잭션 경계도
 *    직접 CRUD 와 같은 `@Transactional()`(typeorm-transactional) 이다 — `dataSource.transaction()` 으로
 *    열면 `lockPolicy()` 의 주입 repository 가 그 트랜잭션에 참여하지 않아 잠금이 새 나간다.
 * 2. **`bumpEpoch()` 는 발효 시에만 부른다.** 예약 등록은 원장 계산에 쓰이는 이력을 바꾸지 않으므로,
 *    등록마다 epoch 를 올리면 원장 생성 측이 근거 없이 직렬화된다.
 * 3. **구간의 기준 시각은 `effectiveAt`** 이다(cron 실행 시각 아님). `discount.interval.split.ts` 참조.
 * 4. **소급 판정은 생성 시점에 박제**한다(`isRetroactive`). cron 시점에는 지연된 미래 예약도 과거라
 *    재판정으로는 구분되지 않는다.
 */
@Injectable()
export class PartnerDiscountReservationService {
  private readonly logger = new Logger(PartnerDiscountReservationService.name);

  constructor(
    @InjectRepository(PartnerDiscountReservationEntity)
    private reservationRepository: Repository<PartnerDiscountReservationEntity>,
    @InjectRepository(PartnerDiscountHistoryEntity)
    private historyRepository: Repository<PartnerDiscountHistoryEntity>,
    @InjectRepository(UserDiscountEntity)
    private userDiscountRepository: Repository<UserDiscountEntity>,
    private readonly historyService: PartnerDiscountHistoryService,
    private readonly repriceService: PartnerSettleRepriceService,
    private readonly featureFlag: PartnerSettleFeatureFlag,
  ) {}

  /** GET settle/discount/reservations */
  async findReservations(query: ReservationQueryDto): Promise<PartnerDiscountReservationEntity[]> {
    const qb = this.reservationRepository
      .createQueryBuilder('r')
      .orderBy('r.effectiveAt', 'DESC')
      .addOrderBy('r.id', 'DESC')
      .take(query.limit ?? 50)
      .skip(query.offset ?? 0);

    if (query.status) qb.andWhere('r.status = :status', { status: query.status });
    if (query.partnerCompanyId) qb.andWhere('r.partnerCompanyId = :pcId', { pcId: query.partnerCompanyId });
    if (query.scopeKey) qb.andWhere('r.scopeKey = :scopeKey', { scopeKey: query.scopeKey });

    return qb.getMany();
  }

  /**
   * POST settle/discount/reservations
   *
   * 멱등: 같은 `requestKey`·같은 payload = 기존 예약 반환, 다른 payload = 409.
   * 같은 (scopeKey, effectiveAt) PENDING 중복은 DB unique 가 막는다(앱 레벨 선검사 아님 —
   * 동시 생성 2건 중 1건만 성공해야 한다).
   */
  async createReservation(
    dto: ReservationCreateReqDto,
    registeredBy: number,
  ): Promise<PartnerDiscountReservationEntity> {
    const scope = this.toScope(dto);
    const effectiveAt = new Date(dto.effectiveAt);
    if (Number.isNaN(effectiveAt.getTime())) {
      throw new BadRequestException('effectiveAt 형식이 올바르지 않습니다.');
    }

    const payloadHash = computePayloadHash(
      {
        scopeKey: buildScopeKey(scope),
        pricePercent: dto.pricePercent,
        priceAdjustment: dto.priceAdjustment,
        effectiveAt: effectiveAt.toISOString(),
      },
      PAYLOAD_HASH_VERSION,
    );

    const existing = await this.reservationRepository.findOne({ where: { requestKey: dto.requestKey } });
    if (existing) return this.assertSamePayload(existing, payloadHash);

    const isRetroactive = effectiveAt.getTime() < (await this.readDbNow()).getTime();
    if (isRetroactive && !this.featureFlag.isDiscountRetroactiveEnabled) {
      throw new BadRequestException('소급 예약은 현재 개방되어 있지 않습니다.');
    }

    return retryOnLockConflict(() =>
      this.insertReservation(scope, dto, effectiveAt, payloadHash, isRetroactive, registeredBy),
    );
  }

  @Transactional()
  private async insertReservation(
    scope: PartnerDiscountScopeFields,
    dto: ReservationCreateReqDto,
    effectiveAt: Date,
    payloadHash: string,
    isRetroactive: boolean,
    registeredBy: number,
  ): Promise<PartnerDiscountReservationEntity> {
    await this.historyService.lockPolicy(scope);

    try {
      const inserted = await this.reservationRepository.insert({
        ...this.toScopeColumns(scope),
        scopeKey: buildScopeKey(scope),
        pricePercent: dto.pricePercent,
        priceAdjustment: dto.priceAdjustment,
        effectiveAt,
        status: IPartnerDiscountReservationStatus.PENDING,
        registeredBy,
        resultHistoryId: null,
        requestKey: dto.requestKey,
        payloadHash,
        payloadHashVersion: PAYLOAD_HASH_VERSION,
        isRetroactive,
        lastFailureCode: null,
        lastFailureAt: null,
      });

      const created = await this.reservationRepository.findOne({
        where: { id: inserted.identifiers[0].id as number },
      });
      if (!created) throw new InternalServerErrorException('정산조건 예약 생성 결과를 읽지 못했습니다.');
      return created;
    } catch (error) {
      throw this.translateInsertConflict(error, dto.requestKey);
    }
  }

  /**
   * DELETE settle/discount/reservations/:id
   *
   * `PENDING` 과 `BLOCKED` 를 모두 취소한다 — BLOCKED 해제의 유일한 경로가 취소 후 재예약이기 때문.
   * 이미 CANCELED 면 200 멱등, APPLIED 면 409(발효분은 소급·차액 proposal 로 정정한다).
   */
  async cancelReservation(id: number): Promise<PartnerDiscountReservationEntity> {
    const result = await this.reservationRepository
      .createQueryBuilder()
      .update()
      .set({ status: IPartnerDiscountReservationStatus.CANCELED })
      .where('id = :id', { id })
      .andWhere('status IN (:...cancelable)', {
        cancelable: [IPartnerDiscountReservationStatus.PENDING, IPartnerDiscountReservationStatus.BLOCKED],
      })
      .execute();

    const reservation = await this.reservationRepository.findOne({ where: { id } });
    if (!reservation) throw new NotFoundException(`정산조건 예약 ${id}을 찾을 수 없습니다.`);

    if (result.affected === 0 && reservation.status === IPartnerDiscountReservationStatus.APPLIED) {
      throw new ConflictException('이미 발효된 예약은 취소할 수 없습니다. 소급 변경으로 정정하십시오.');
    }

    return reservation;
  }

  /**
   * 발효 대상(`PENDING` 이고 `effectiveAt` 이 지난 예약)을 순서대로 처리한다. cron 진입점.
   *
   * 한 건이 실패해도 나머지는 계속한다 — 한 scope 의 정책 충돌이 다른 협력사의 예약을 막으면 안 된다.
   */
  async applyDueReservations(): Promise<ReservationApplyOutcome[]> {
    if (!this.featureFlag.isDiscountReservationCronEnabled) return [];

    const now = await this.readDbNow();
    const due = await this.reservationRepository
      .createQueryBuilder('r')
      .where('r.status = :status', { status: IPartnerDiscountReservationStatus.PENDING })
      .andWhere('r.effectiveAt <= :now', { now })
      .orderBy('r.effectiveAt', 'ASC')
      .addOrderBy('r.id', 'ASC')
      .getMany();

    const outcomes: ReservationApplyOutcome[] = [];
    for (const reservation of due) {
      try {
        outcomes.push(await retryOnLockConflict(() => this.applyReservation(reservation.id)));
      } catch (error) {
        if (error instanceof IntervalInvariantError) {
          // 분할 결과가 timeline 을 깨뜨렸다. 트랜잭션은 이미 롤백됐으므로 사실만 남기고 종결한다.
          outcomes.push(
            await this.markBlockedAfterRollback(
              reservation.id,
              IPartnerDiscountReservationFailureCode.INTERVAL_INVARIANT,
            ),
          );
          continue;
        }
        // 잠금 경합은 다음 주기로 이월한다(상태 변경 없음). 그 외 예외도 한 건에 가둔다.
        this.logger.error(`정산조건 예약 ${reservation.id} 발효 실패`, error as Error);
      }
    }
    return outcomes;
  }

  /**
   * 예약 1건 발효. 한 트랜잭션 =
   * 잠금 → PENDING 재검증 → 소급 게이트 → 방향 충돌 검사 → history 분할 → 불변식 검증 →
   * user_discount 반영 → PENDING→APPLIED CAS → epoch++.
   */
  @Transactional()
  async applyReservation(reservationId: number): Promise<ReservationApplyOutcome> {
    const preview = await this.reservationRepository.findOne({ where: { id: reservationId } });
    if (!preview) throw new NotFoundException(`정산조건 예약 ${reservationId}을 찾을 수 없습니다.`);

    // 잠금 순서 고정: 정책(epoch → policyTargetKey → scopeKey) 을 먼저 잡고 그 다음 예약 row 다.
    await this.historyService.lockPolicy(this.toScope(preview));

    const reservation = await this.reservationRepository
      .createQueryBuilder('r')
      .setLock('pessimistic_write')
      .where('r.id = :id', { id: reservationId })
      .getOne();

    if (!reservation || reservation.status !== IPartnerDiscountReservationStatus.PENDING) {
      // 동시 cron 이 이미 처리했거나 운영자가 취소했다. 승자가 하나뿐이면 된다.
      return this.toOutcome(reservation ?? preview);
    }

    if (reservation.isRetroactive && !this.featureFlag.isDiscountRetroactiveEnabled) {
      return this.recordFailure(
        reservation,
        IPartnerDiscountReservationFailureCode.RETROACTIVE_DISABLED,
        IPartnerDiscountReservationStatus.PENDING,
      );
    }

    const conflict = await this.findDirectionConflict(reservation);
    if (conflict) {
      this.logger.warn(`정산조건 예약 ${reservation.id} 발효 거부 — ${conflict}`);
      return this.recordFailure(
        reservation,
        IPartnerDiscountReservationFailureCode.POLICY_CONFLICT,
        IPartnerDiscountReservationStatus.BLOCKED,
      );
    }

    const resultHistoryId = await this.applyHistorySplit(reservation);

    const violation = findTimelineViolation(await this.loadActiveIntervals(reservation.scopeKey));
    if (violation) {
      // 커밋하면 같은 occurredAt 에 두 할인율이 매칭돼 원장 금액이 실행 순서에 따라 달라진다.
      throw new IntervalInvariantError(violation);
    }

    // 모든 예약은 발효 시점 이후에 기존 조건으로 생성된 원장이 있을 수 있다. 대상이 없으면
    // reprice 서비스가 0/0으로 종료한다.
    await this.repriceService.repriceForReservation(
      { partnerCompanyId: reservation.partnerCompanyId, effectiveAt: reservation.effectiveAt },
      resultHistoryId,
      this.reservationRepository.manager,
    );

    await this.applyToUserDiscount(reservation);

    const transition = await this.reservationRepository
      .createQueryBuilder()
      .update()
      .set({ status: IPartnerDiscountReservationStatus.APPLIED, resultHistoryId, lastFailureCode: null })
      .where('id = :id', { id: reservation.id })
      .andWhere('status = :pending', { pending: IPartnerDiscountReservationStatus.PENDING })
      .execute();

    if (transition.affected !== 1) {
      throw new InternalServerErrorException('정산조건 예약 상태 전이에 실패했습니다.');
    }

    await this.historyService.bumpEpoch(reservation.partnerCompanyId);

    return {
      reservationId: reservation.id,
      status: IPartnerDiscountReservationStatus.APPLIED,
      resultHistoryId,
      failureCode: null,
    };
  }

  /**
   * 구간 분할 계획을 DB 에 반영하고 **새 값 구간**의 id 를 돌려준다.
   *
   * 복제 구간이 아니라 새 값 구간이 `resultHistoryId` 다 — 예약이 무엇을 적용했는지 추적하는 값이므로.
   *
   * 순서는 **선행 op(CLOSE/RETIRE) → INSERT → 후행 링크(SUPERSEDE/RETIRE)** 로 고정한다.
   * `UNIQUE(open_key)` 가 scope 당 열린 구간 1개만 허용하므로, 기존 열린 구간을 비우기 전에 새 열린
   * 구간을 INSERT 하면 정상 경로가 duplicate key 로 롤백된다. 슬롯이 잠시 비는 것은 문제되지 않는다 —
   * 이 트랜잭션이 `lockPolicy()` 로 scopeKey 앵커를 이미 잡고 있어 다른 writer 가 끼어들 수 없다.
   */
  private async applyHistorySplit(reservation: PartnerDiscountReservationEntity): Promise<number> {
    const intervals = await this.loadActiveIntervals(reservation.scopeKey, true);
    const plan = planIntervalSplit(intervals, reservation.effectiveAt);
    const scopeColumns = this.toScopeColumns(this.toScope(reservation));

    for (const op of plan.ops) {
      if (op.op === 'CLOSE') {
        const closed = await this.historyRepository.update(
          { id: op.id, validTo: IsNull() },
          { validTo: op.validTo },
        );
        if (closed.affected !== 1) {
          throw new InternalServerErrorException('정산조건 이력 구간 마감에 실패했습니다.');
        }
      } else if (op.op === 'RETIRE') {
        // 남길 앞부분이 없는 열린 구간. validTo = effectiveAt 은 validFrom < validTo CHECK 를 깨므로
        // soft delete 로 open_key 를 비운다. 대체 링크는 INSERT 뒤에 건다.
        const retired = await this.historyRepository.softDelete({ id: op.id, deletedAt: IsNull() });
        if (retired.affected !== 1) {
          throw new InternalServerErrorException('정산조건 이력 구간 퇴역에 실패했습니다.');
        }
      }
    }

    let resultHistoryId: number | null = null;
    for (const planned of plan.inserts) {
      const inserted = await this.historyRepository.insert({
        ...scopeColumns,
        scopeKey: reservation.scopeKey,
        changeType: planned.changeType,
        ...this.valuesFor(planned, reservation),
        validFrom: planned.validFrom,
        validTo: planned.validTo,
        changedBy: reservation.registeredBy,
        supersededByHistoryId: null,
      });

      if (planned.kind === 'NEW') resultHistoryId = inserted.identifiers[0].id as number;
    }

    if (resultHistoryId === null) {
      throw new InternalServerErrorException('정산조건 예약 발효 결과 구간이 생성되지 않았습니다.');
    }

    for (const op of plan.ops) {
      if (op.op === 'CLOSE') continue; // 마감된 row 는 앞부분을 계속 표현한다 — 대체된 것이 아니다.

      const marked = await this.historyRepository.update(
        { id: op.id, supersededByHistoryId: IsNull() },
        { supersededByHistoryId: resultHistoryId },
      );
      if (marked.affected !== 1) {
        throw new InternalServerErrorException('정산조건 이력 supersede 마킹에 실패했습니다.');
      }
    }

    return resultHistoryId;
  }

  /** 복제 구간은 원본 값을, 새 구간은 예약 값을 쓴다. tombstone 복제는 값이 NULL 이어야 CHECK 를 통과한다. */
  private valuesFor(planned: PlannedInsert, reservation: PartnerDiscountReservationEntity) {
    if (planned.kind === 'CLONE' && planned.source) {
      return {
        pricePercent: planned.source.pricePercent,
        priceAdjustment: planned.source.priceAdjustment as PartnerDiscountHistoryEntity['priceAdjustment'],
      };
    }
    return { pricePercent: reservation.pricePercent, priceAdjustment: reservation.priceAdjustment };
  }

  private async loadActiveIntervals(scopeKey: string, lock = false): Promise<ActiveInterval[]> {
    const qb = this.historyRepository
      .createQueryBuilder('h')
      .where('h.scopeKey = :scopeKey', { scopeKey })
      .andWhere('h.supersededByHistoryId IS NULL')
      .orderBy('h.validFrom', 'ASC');

    if (lock) qb.setLock('pessimistic_write');

    const rows = await qb.getMany();
    return rows.map((row) => ({
      id: row.id,
      validFrom: row.validFrom,
      validTo: row.validTo,
      changeType: row.changeType,
      pricePercent: row.pricePercent,
      priceAdjustment: row.priceAdjustment,
    }));
  }

  /**
   * 같은 정책 대상(policyTargetKey)에 반대 방향(할인↔할증)이 동시에 활성이 되는지 본다.
   *
   * matcher 는 방향이 갈린 후보를 만나면 예외를 던지고 원장 계산은 그 사건을 NEEDS_REVIEW 로 격리한다.
   * 예약이 그 상태를 만들도록 두면 발효 이후의 모든 사건이 격리되므로 발효 자체를 막는다.
   */
  private async findDirectionConflict(reservation: PartnerDiscountReservationEntity): Promise<string | null> {
    const targetKey = buildPolicyTargetKey(this.toScope(reservation));

    const rows = await this.historyRepository
      .createQueryBuilder('h')
      .where('h.partnerCompanyId = :partnerCompanyId', { partnerCompanyId: reservation.partnerCompanyId })
      .andWhere('h.supersededByHistoryId IS NULL')
      .andWhere('h.scopeKey <> :scopeKey', { scopeKey: reservation.scopeKey })
      .andWhere('h.changeType <> :tombstone', { tombstone: IPartnerDiscountChangeType.DELETE })
      .andWhere('h.validFrom <= :at', { at: reservation.effectiveAt })
      .andWhere('(h.validTo IS NULL OR h.validTo > :at)', { at: reservation.effectiveAt })
      .getMany();

    const conflicting = rows.find(
      (row) =>
        buildPolicyTargetKey(this.toScope(row)) === targetKey && row.priceAdjustment !== reservation.priceAdjustment,
    );

    return conflicting
      ? `같은 대상에 ${conflicting.priceAdjustment} 조건(history ${conflicting.id})이 이미 활성입니다.`
      : null;
  }

  /**
   * 새 구간이 **현재 시각을 커버할 때만** `user_discount` 현재값을 갱신한다.
   * 닫힌 과거 구간만 바뀌는 소급은 현재값을 건드리지 않는다.
   */
  private async applyToUserDiscount(reservation: PartnerDiscountReservationEntity): Promise<void> {
    const now = await this.readDbNow();
    const current = (await this.loadActiveIntervals(reservation.scopeKey)).find(
      (interval) =>
        interval.validFrom.getTime() <= now.getTime() &&
        (interval.validTo === null || interval.validTo.getTime() > now.getTime()),
    );

    if (!current || current.validFrom.getTime() !== reservation.effectiveAt.getTime()) return;

    const qb = this.userDiscountRepository
      .createQueryBuilder()
      .update()
      .set({ pricePercent: reservation.pricePercent, priceAdjustment: reservation.priceAdjustment })
      .where('partner_company_id = :partnerCompanyId', { partnerCompanyId: reservation.partnerCompanyId })
      .andWhere('user_id IS NULL')
      .andWhere('category = :category', { category: reservation.category })
      .andWhere('method = :method', { method: reservation.method })
      .andWhere('compare_condition = :compareCondition', { compareCondition: reservation.compareCondition });

    // NULL 은 `= NULL` 로 비교되지 않는다. scope 필드가 NULL 인 예약이 아무 row 도 못 찾는 것을 막는다.
    this.andNullable(qb, 'classification_id', 'classificationId', reservation.classificationId);
    this.andNullable(qb, 'primary_category', 'primaryCategory', reservation.primaryCategory);
    this.andNullable(qb, '`group`', 'group', reservation.group);
    this.andNullable(qb, '`range`', 'range', reservation.range);

    await qb.execute();
  }

  private andNullable(
    qb: { andWhere: (condition: string, parameters?: Record<string, unknown>) => unknown },
    column: string,
    parameter: string,
    value: unknown,
  ): void {
    if (value === null || value === undefined) {
      qb.andWhere(`${column} IS NULL`);
      return;
    }
    qb.andWhere(`${column} = :${parameter}`, { [parameter]: value });
  }

  private async recordFailure(
    reservation: PartnerDiscountReservationEntity,
    failureCode: IPartnerDiscountReservationFailureCode,
    status: IPartnerDiscountReservationStatus,
  ): Promise<ReservationApplyOutcome> {
    const repeated = reservation.lastFailureCode === failureCode;

    await this.reservationRepository
      .createQueryBuilder()
      .update()
      .set({ status, lastFailureCode: failureCode, lastFailureAt: await this.readDbNow() })
      .where('id = :id', { id: reservation.id })
      .andWhere('status = :pending', { pending: IPartnerDiscountReservationStatus.PENDING })
      .execute();

    // 같은 사유가 반복되는 PENDING(소급 flag off)은 매 주기 같은 줄을 찍지 않는다.
    if (!repeated) {
      this.logger.log(`정산조건 예약 ${reservation.id} 미발효 — ${failureCode}`);
    }

    return { reservationId: reservation.id, status, resultHistoryId: null, failureCode };
  }

  /** 불변식 위반으로 롤백된 예약을 BLOCKED 로 종결한다(재시도 없음). */
  private async markBlockedAfterRollback(
    reservationId: number,
    failureCode: IPartnerDiscountReservationFailureCode,
  ): Promise<ReservationApplyOutcome> {
    await this.reservationRepository
      .createQueryBuilder()
      .update()
      .set({
        status: IPartnerDiscountReservationStatus.BLOCKED,
        lastFailureCode: failureCode,
        lastFailureAt: await this.readDbNow(),
      })
      .where('id = :id', { id: reservationId })
      .andWhere('status = :pending', { pending: IPartnerDiscountReservationStatus.PENDING })
      .execute();

    this.logger.warn(`정산조건 예약 ${reservationId} 발효 거부 — ${failureCode}`);
    return { reservationId, status: IPartnerDiscountReservationStatus.BLOCKED, resultHistoryId: null, failureCode };
  }

  private assertSamePayload(
    existing: PartnerDiscountReservationEntity,
    payloadHash: string,
  ): PartnerDiscountReservationEntity {
    if (existing.payloadHash !== payloadHash) {
      throw new ConflictException('같은 requestKey 로 다른 내용의 예약이 이미 등록되어 있습니다.');
    }
    return existing;
  }

  /**
   * INSERT unique 위반을 의미 있는 응답으로 바꾼다.
   * - requestKey 충돌 = 같은 키의 동시 재시도. 승자의 결과를 조회하도록 안내한다.
   * - active_key 충돌 = 같은 scope·같은 시각에 이미 PENDING 이 있다.
   */
  private translateInsertConflict(error: unknown, requestKey: string): unknown {
    const message = (error as { message?: string })?.message ?? '';

    if (message.includes('uk_partner_discount_reservation_request')) {
      return new ConflictException(`동일 requestKey(${requestKey}) 예약이 이미 처리 중입니다. 잠시 후 조회하십시오.`);
    }
    if (message.includes('uk_partner_discount_reservation_active')) {
      return new ConflictException('같은 정산조건·같은 적용 시각의 대기 중 예약이 이미 있습니다.');
    }
    return error;
  }

  private toOutcome(reservation: PartnerDiscountReservationEntity): ReservationApplyOutcome {
    return {
      reservationId: reservation.id,
      status: reservation.status,
      resultHistoryId: reservation.resultHistoryId,
      failureCode: reservation.lastFailureCode,
    };
  }

  private async readDbNow(): Promise<Date> {
    const rows = await this.reservationRepository.query(`SELECT NOW(6) AS now6`);
    return new Date(rows[0].now6);
  }

  private toScope(source: ScopeCarrier): PartnerDiscountScopeFields {
    return {
      partnerCompanyId: source.partnerCompanyId,
      category: source.category,
      classificationId: source.classificationId ?? null,
      method: source.method,
      primaryCategory: source.primaryCategory ?? null,
      group: source.group ?? null,
      range: normalizeScopeRange(source.range),
      compareCondition: source.compareCondition,
    };
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
