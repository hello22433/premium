import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Propagation, Transactional } from 'typeorm-transactional';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { OrderDeliverySsgInsertStateEntity } from '../../entity/order.delivery.ssg.insert.state.entity';
import { SsgIssueLogEntity } from '../../entity/ssg.issue.log.entity';
import { SsgInsertState } from '../interface/ssg.insert.state';

/**
 * markAttempted 입력: INSERT 시도 시점의 PIN/메타.
 * orphan resolver가 SSG check 후 등록된 PIN을 복원하려면 attempt 단위로 durable 보존 필요.
 */
export interface SsgAttemptPayload {
  barCode: string;
  personalCode: string;
  ssgTransactionId: string;
  eventNo: string;
  expireAt: Date | null;
  encourageAt: Date | null;
  couponNum: string | null;
}

/**
 * markConfirmed 입력: SSG 응답 1000 받은 후 order_delivery에 반영해야 할 PIN/메타.
 * order_delivery 컬럼은 save() 덮어쓰기 위험이 있으나, 신호(state) 자체는 별 테이블에서 무결.
 * 진실의 원천 PIN payload는 ssg_issue_log (markAttempted에서 저장).
 */
export interface SsgConfirmInfo {
  barCode: string;
  personalCode: string;
  ssgTransactionId: string;
  couponNum: string | null;
  expireAt: Date | null;
  encourageAt: Date | null;
}

/**
 * SSG INSERT durable state 전이 helper.
 * plans/ssg-balance-refactor.md PR1.
 *
 * 신호 데이터는 `order_delivery_ssg_insert_state` 별 테이블에 보관한다 (signal column 무결성 정책).
 * `order_delivery.save()`가 메모리 stale 값으로 신호를 덮어쓸 수 없도록 별 row로 격리.
 *
 * 모든 mark*() 호출은 REQUIRES_NEW 트랜잭션으로 격리되어, 호출자 트랜잭션이 롤백돼도
 * state + 그에 필요한 payload/PIN 정보는 함께 commit된다.
 *
 * state machine (Lazy):
 *   (row 없음 = NONE) → ATTEMPTED → (CONFIRMED | FAILED)
 *   FAILED → ATTEMPTED 재시도 허용 (재발송 새 PIN 발급)
 * CONFIRMED 만 진짜 terminal. NONE에서 terminal 직행 차단(durable payload 누락 방지).
 *
 * helper는 state 전이 + 그에 필요한 durable 데이터를 같은 REQUIRES_NEW에서 같이 처리한다:
 *   - markAttempted: state row UPSERT (NONE→ATTEMPTED, FAILED→ATTEMPTED) + ssg_issue_log payload INSERT
 *   - markConfirmed: state row UPDATE (ATTEMPTED→CONFIRMED) + order_delivery PIN 컬럼 best-effort 저장
 *   - markFailed:    state row UPDATE (ATTEMPTED→FAILED)
 */
@Injectable()
export class SsgInsertStateService {
  private readonly logger = new Logger(SsgInsertStateService.name);

  constructor(
    @InjectRepository(OrderDeliverySsgInsertStateEntity)
    private readonly stateRepository: Repository<OrderDeliverySsgInsertStateEntity>,
    @InjectRepository(OrderDeliveryEntity)
    private readonly deliveryRepository: Repository<OrderDeliveryEntity>,
    @InjectRepository(SsgIssueLogEntity)
    private readonly issueLogRepository: Repository<SsgIssueLogEntity>,
  ) {}

  /**
   * (row 없음 = NONE) → ATTEMPTED, 또는 FAILED → ATTEMPTED 재시도.
   *
   * 두 단계 전이 (같은 REQUIRES_NEW 안):
   *   1) INSERT IGNORE state row with ATTEMPTED — row 없으면 신규 INSERT (affected=1).
   *   2) row 이미 있으면 (1)에서 affected=0 → UPDATE WHERE state=FAILED 시도.
   *      재발송 새 PIN 발급은 FAILED 재시도이므로 ATTEMPTED로 복원.
   *      이미 ATTEMPTED(중복 호출) 또는 CONFIRMED(terminal)면 두 단계 모두 affected=0 → idempotent skip.
   *   3) 둘 중 하나라도 전이 성공 시 ssg_issue_log 새 attempt payload INSERT.
   *      payload는 attempt 단위로 누적되어 orphan resolver가 최신순 후보 lookup 가능.
   */
  @Transactional({ propagation: Propagation.REQUIRES_NEW })
  async markAttempted(orderDeliveryId: number, payload: SsgAttemptPayload): Promise<void> {
    const insertResult = await this.stateRepository
      .createQueryBuilder()
      .insert()
      .into(OrderDeliverySsgInsertStateEntity)
      .values({ orderDeliveryId, state: SsgInsertState.ATTEMPTED })
      .orIgnore()
      .execute();

    const insertAffected = ((insertResult.raw as { affectedRows?: number } | undefined)?.affectedRows ?? 0) > 0;

    let transitioned = insertAffected;
    if (!insertAffected) {
      const updateResult = await this.stateRepository
        .createQueryBuilder()
        .update(OrderDeliverySsgInsertStateEntity)
        .set({ state: SsgInsertState.ATTEMPTED })
        .where('order_delivery_id = :id', { id: orderDeliveryId })
        .andWhere('state = :prev', { prev: SsgInsertState.FAILED })
        .execute();
      transitioned = (updateResult.affected ?? 0) > 0;
    }

    if (!transitioned) {
      this.logger.debug(
        `markAttempted skipped (state row already ATTEMPTED or CONFIRMED): id=${orderDeliveryId}`,
      );
      return;
    }

    await this.issueLogRepository.insert({
      orderDeliveryId,
      insertedAt: new Date(),
      ...payload,
    });
  }

  /**
   * ATTEMPTED → CONFIRMED.
   *
   * state 전이 우선 (WHERE state=ATTEMPTED 가드). 전이 성공 시 order_delivery PIN 컬럼 best-effort 저장.
   * order_delivery 컬럼은 caller save()로 덮일 수 있으나, 신호(state)는 별 테이블에 무결.
   * 진실의 원천 PIN payload는 ssg_issue_log (markAttempted에서 이미 저장됨).
   */
  @Transactional({ propagation: Propagation.REQUIRES_NEW })
  async markConfirmed(orderDeliveryId: number, pinInfo: SsgConfirmInfo): Promise<void> {
    const stateResult = await this.stateRepository
      .createQueryBuilder()
      .update(OrderDeliverySsgInsertStateEntity)
      .set({ state: SsgInsertState.CONFIRMED })
      .where('order_delivery_id = :id', { id: orderDeliveryId })
      .andWhere('state = :prev', { prev: SsgInsertState.ATTEMPTED })
      .execute();

    if (!stateResult.affected) {
      this.logger.warn(
        `markConfirmed skipped: id=${orderDeliveryId}. state row가 ATTEMPTED 아님 (row 없음/CONFIRMED/FAILED). 호출 순서 검토 필요.`,
      );
      return;
    }

    await this.deliveryRepository
      .createQueryBuilder()
      .update(OrderDeliveryEntity)
      .set({
        barCode: pinInfo.barCode,
        personalCode: pinInfo.personalCode,
        ssgTransactionId: pinInfo.ssgTransactionId,
        couponNum: pinInfo.couponNum,
        expireAt: pinInfo.expireAt,
        encourageAt: pinInfo.encourageAt,
      })
      .where('id = :id', { id: orderDeliveryId })
      .execute();
  }

  /**
   * ATTEMPTED → FAILED. state 만 전이 (실패에는 보존할 PIN 데이터 없음).
   * row 없음(NONE) / CONFIRMED 에서는 전이하지 않음 (state machine 엄격).
   */
  @Transactional({ propagation: Propagation.REQUIRES_NEW })
  async markFailed(orderDeliveryId: number): Promise<void> {
    const result = await this.stateRepository
      .createQueryBuilder()
      .update(OrderDeliverySsgInsertStateEntity)
      .set({ state: SsgInsertState.FAILED })
      .where('order_delivery_id = :id', { id: orderDeliveryId })
      .andWhere('state = :prev', { prev: SsgInsertState.ATTEMPTED })
      .execute();

    if (!result.affected) {
      this.logger.warn(
        `markFailed skipped: id=${orderDeliveryId}. state row가 ATTEMPTED 아님 (row 없음/CONFIRMED/FAILED).`,
      );
    }
  }

  /**
   * 현재 state 조회. row 없으면 NONE 반환 (Lazy 정책).
   */
  async getState(orderDeliveryId: number): Promise<SsgInsertState> {
    const row = await this.stateRepository.findOne({ where: { orderDeliveryId } });
    return row?.state ?? SsgInsertState.NONE;
  }
}
