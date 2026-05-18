import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Propagation, Transactional } from 'typeorm-transactional';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
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
 * state 전이와 같은 트랜잭션 안에서 commit되어 orphan(state=CONFIRMED인데 PIN 정보 없음) 방지.
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
 * 모든 mark*() 호출은 REQUIRES_NEW 트랜잭션으로 격리되어, 호출자 트랜잭션이 롤백돼도
 * state + 그에 필요한 payload/PIN 정보는 함께 commit된다. SSG 행사 한도가 gross 모델
 * (시도 누계)이라 "INSERT 시도 사실"을 영구 기록해야 하기 때문이다.
 *
 * state machine (엄격):
 *   NONE → ATTEMPTED   (markAttempted)
 *   ATTEMPTED → CONFIRMED   (markConfirmed)
 *   ATTEMPTED → FAILED      (markFailed)
 * terminal(CONFIRMED/FAILED)은 변경 불가. NONE에서 terminal 직행도 차단(durable payload 누락 방지).
 *
 * helper는 state 전이 + 그에 필요한 durable 데이터를 같은 REQUIRES_NEW에서 같이 처리한다:
 *   - markAttempted: ssg_issue_log INSERT (payload) + order_delivery state ATTEMPTED
 *   - markConfirmed: order_delivery PIN 정보(barCode/personalCode/couponNum/ssgTransactionId/
 *                    expireAt/encourageAt) 저장 + state CONFIRMED
 *   - markFailed:    state FAILED만 (실패에는 보존할 PIN 데이터 없음)
 *
 * PR1에서는 helper 정의만 한다. 실제 호출은 PR2 (issue() flow, orphan resolver).
 */
@Injectable()
export class SsgInsertStateService {
  private readonly logger = new Logger(SsgInsertStateService.name);

  constructor(
    @InjectRepository(OrderDeliveryEntity)
    private readonly deliveryRepository: Repository<OrderDeliveryEntity>,
    @InjectRepository(SsgIssueLogEntity)
    private readonly issueLogRepository: Repository<SsgIssueLogEntity>,
  ) {}

  /**
   * NONE → ATTEMPTED. 같은 REQUIRES_NEW에서 state 전이 + ssg_issue_log payload INSERT를 commit.
   *
   * 순서가 중요: 먼저 state UPDATE(NONE → ATTEMPTED)를 시도하고, affected=1인 경우에만 log INSERT.
   * 이미 ATTEMPTED 이상이면 state WHERE 가드가 0 affected를 반환 → INSERT도 skip → idempotent.
   * (역순으로 INSERT 먼저 하면 재호출 시 state skip돼도 log row만 중복 쌓인다.)
   */
  @Transactional({ propagation: Propagation.REQUIRES_NEW })
  async markAttempted(orderDeliveryId: number, payload: SsgAttemptPayload): Promise<void> {
    const result = await this.deliveryRepository
      .createQueryBuilder()
      .update(OrderDeliveryEntity)
      .set({ ssgInsertState: SsgInsertState.ATTEMPTED })
      .where('id = :id', { id: orderDeliveryId })
      .andWhere('ssg_insert_state = :prev', { prev: SsgInsertState.NONE })
      .execute();

    if (!result.affected) {
      this.logger.debug(`markAttempted skipped (already ATTEMPTED or terminal): id=${orderDeliveryId}`);
      return;
    }

    await this.issueLogRepository.insert({
      orderDeliveryId,
      insertedAt: new Date(),
      ...payload,
    });
  }

  /**
   * ATTEMPTED → CONFIRMED. PIN 정보를 order_delivery에 저장 + state 전이를 한 REQUIRES_NEW에서 commit.
   * NONE/FAILED 에서는 전이하지 않음 (state machine 엄격: durable payload 없는 상태에서 terminal 진입 방지).
   * 같은 attempt에 대해 이미 CONFIRMED 면 silently skip (idempotent).
   */
  @Transactional({ propagation: Propagation.REQUIRES_NEW })
  async markConfirmed(orderDeliveryId: number, pinInfo: SsgConfirmInfo): Promise<void> {
    const result = await this.deliveryRepository
      .createQueryBuilder()
      .update(OrderDeliveryEntity)
      .set({
        ssgInsertState: SsgInsertState.CONFIRMED,
        barCode: pinInfo.barCode,
        personalCode: pinInfo.personalCode,
        ssgTransactionId: pinInfo.ssgTransactionId,
        couponNum: pinInfo.couponNum,
        expireAt: pinInfo.expireAt,
        encourageAt: pinInfo.encourageAt,
      })
      .where('id = :id', { id: orderDeliveryId })
      .andWhere('ssg_insert_state = :prev', { prev: SsgInsertState.ATTEMPTED })
      .execute();

    if (!result.affected) {
      this.logger.warn(
        `markConfirmed skipped: id=${orderDeliveryId}. ATTEMPTED 아닌 state에서 호출됨 (durable payload 누락 가능, 호출 순서 검토 필요).`,
      );
    }
  }

  /**
   * ATTEMPTED → FAILED. state 만 전이 (실패에는 보존할 PIN 데이터 없음).
   * NONE/CONFIRMED 에서는 전이하지 않음 (state machine 엄격).
   */
  @Transactional({ propagation: Propagation.REQUIRES_NEW })
  async markFailed(orderDeliveryId: number): Promise<void> {
    const result = await this.deliveryRepository
      .createQueryBuilder()
      .update(OrderDeliveryEntity)
      .set({ ssgInsertState: SsgInsertState.FAILED })
      .where('id = :id', { id: orderDeliveryId })
      .andWhere('ssg_insert_state = :prev', { prev: SsgInsertState.ATTEMPTED })
      .execute();

    if (!result.affected) {
      this.logger.warn(
        `markFailed skipped: id=${orderDeliveryId}. ATTEMPTED 아닌 state에서 호출됨 (CONFIRMED 역행 시도 또는 NONE 직행 시도).`,
      );
    }
  }

  /**
   * 현재 state 조회.
   */
  async getState(orderDeliveryId: number): Promise<SsgInsertState | null> {
    const row = await this.deliveryRepository
      .createQueryBuilder('od')
      .select('od.ssgInsertState', 'state')
      .where('od.id = :id', { id: orderDeliveryId })
      .getRawOne<{ state: SsgInsertState }>();
    return row?.state ?? null;
  }
}
