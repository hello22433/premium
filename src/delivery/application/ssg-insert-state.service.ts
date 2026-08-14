import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Propagation, Transactional } from 'typeorm-transactional';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { OrderDeliverySsgInsertStateEntity } from '../../entity/order.delivery.ssg.insert.state.entity';
import { SsgIssueLogEntity } from '../../entity/ssg.issue.log.entity';
import { SsgIssueLogKeyCollisionError } from '../../partner_company_extern/infra/ssg.issue';
import { PinIssueCommandEntity } from '../../entity/pin.issue.command.entity';
import {
  hasConsumedSsgIssueAuthority,
  PinIssueCommandAuthority,
} from './pin-issue-command.service';
import { MarkAttemptedResult, SsgInsertState } from '../interface/ssg.insert.state';

/**
 * ssg_issue_log 후보 유일성 인덱스. 이 두 개의 위반만 typed 충돌로 승격한다.
 * docs/plans/2026-08-04-ssg-issue-log-unique-typed-collision.md §3-3.
 */
const SSG_ISSUE_LOG_UNIQUE_KEYS: ReadonlyArray<{ index: string; key: 'bar_code' | 'personal_code' }> = [
  { index: 'uq_ssg_issue_log_bar_code', key: 'bar_code' },
  { index: 'uq_ssg_issue_log_personal_code', key: 'personal_code' },
];

/**
 * driver 오류가 ssg_issue_log 후보 유일성 위반인지 판정한다.
 *
 * errno=1062 만으로는 부족하다. ER_DUP_ENTRY 이면서 위반 키 이름이 위 두 인덱스 중 하나여야 한다.
 * 키 이름 포맷은 엔진마다 다르므로 양쪽을 모두 수용한다:
 *   MySQL 8    : Duplicate entry '...' for key 'ssg_issue_log.uq_ssg_issue_log_bar_code'
 *   MariaDB 10 : Duplicate entry '...' for key 'uq_ssg_issue_log_bar_code'
 *
 * 그 외 unique 충돌·DB 오류는 null 을 반환해 원본 그대로 전파시킨다.
 * (오분류하면 다른 고객의 PIN 복구 분기로 진입할 수 있다.)
 *
 * export 이유: 실 엔진이 만드는 sqlMessage 포맷을 db-integration 테스트가 직접 검증한다.
 */
export function classifySsgIssueLogCollision(e: unknown): 'bar_code' | 'personal_code' | null {
  const driver = (e as { driverError?: unknown })?.driverError ?? e;
  const code = (driver as { code?: unknown })?.code;
  if (code !== 'ER_DUP_ENTRY') {
    return null;
  }
  const message = [(driver as { sqlMessage?: unknown })?.sqlMessage, (driver as { message?: unknown })?.message]
    .filter((v): v is string => typeof v === 'string')
    .join(' ');
  const matched = SSG_ISSUE_LOG_UNIQUE_KEYS.find(({ index }) => message.includes(index));
  return matched?.key ?? null;
}

/**
 * markAttempted 입력: INSERT 시도 시점의 PIN/메타.
 * orphan resolver가 SSG check 후 등록된 PIN을 복원하려면 attempt 단위로 durable 보존 필요.
 *
 * eventSeq, ssgEventId 는 SSG check API 호출 파라미터 완성용 (plans/ssg-balance-refactor.md PR2).
 */
export interface SsgAttemptPayload {
  barCode: string;
  personalCode: string;
  ssgTransactionId: string;
  eventNo: string;
  eventSeq: number;
  ssgEventId: number;
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
  /** 재사용/dedup 복구 시 PIN 과 함께 order_delivery.ssgEventId(행사 귀속)도 같은 REQUIRES_NEW 로 durable 반영 */
  ssgEventId?: number | null;
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
   *      이미 ATTEMPTED(중복 호출) 또는 CONFIRMED(terminal)면 두 단계 모두 affected=0.
   *   3) 둘 중 하나라도 전이 성공 시 ssg_issue_log 새 attempt payload INSERT.
   *      payload는 attempt 단위로 누적되어 orphan resolver가 최신순 후보 lookup 가능.
   *   4) 두 단계 모두 affected=0 이면 현재 state를 조회해 ACTIVE / TERMINAL 결과로 구분.
   *      caller는 결과에 따라 typed error를 throw해 외부 INSERT 호출을 막아야 한다.
   *      (plans/ssg-balance-refactor.md PR2 — silently skip + caller 진행은 "state 없는 INSERT" 위험.)
   *
   * ssg_issue_log 후보 유일성(uq_ssg_issue_log_bar_code / _personal_code) 위반은
   * SsgIssueLogKeyCollisionError 로 승격한다. 이 REQUIRES_NEW 트랜잭션이 통째로 롤백되므로
   * state 전이도 함께 되감기고, 호출자는 다음 PIN 후보로 안전하게 진행할 수 있다.
   * docs/plans/2026-08-04-ssg-issue-log-unique-typed-collision.md
   */
  @Transactional({ propagation: Propagation.REQUIRES_NEW })
  async markAttempted(
    orderDeliveryId: number,
    payload: SsgAttemptPayload,
    authority: PinIssueCommandAuthority | undefined,
  ): Promise<MarkAttemptedResult> {
    if (!(await this.lockCurrentConsumedIssueAuthority(authority))) {
      this.logger.warn(`markAttempted skipped (SSG INSERT authority stale): id=${orderDeliveryId}.`);
      return MarkAttemptedResult.SKIPPED_ACTIVE;
    }
    const insertResult = await this.stateRepository
      .createQueryBuilder()
      .insert()
      .into(OrderDeliverySsgInsertStateEntity)
      .values({ orderDeliveryId, state: SsgInsertState.ATTEMPTED })
      .orIgnore()
      // orIgnore 가 기존 row 를 스킵하면 insertId 가 없다. createdAt/updatedAt 같은
      // CreateDate/UpdateDate 컬럼 때문에 TypeORM 이 INSERT 후 entity 를 id 로 재조회하려다
      // "Cannot update entity because entity id is not set" 로 throw 한다.
      // 여기선 affectedRows 만 쓰므로 entity 갱신을 끈다 (재발송=FAILED row 존재 시 터지던 버그).
      .updateEntity(false)
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

    if (transitioned) {
      try {
        await this.issueLogRepository.insert({
          orderDeliveryId,
          insertedAt: new Date(),
          ...payload,
        });
      } catch (e) {
        const collidedKey = classifySsgIssueLogCollision(e);
        if (!collidedKey) {
          throw e;
        }
        this.logger.warn(
          `[SSG] 후보 PIN 유일성 충돌(${collidedKey}) - orderDeliveryId=${orderDeliveryId}, barCode=${payload.barCode}, personalCode=${payload.personalCode}. 다음 후보로 진행.`,
        );
        throw new SsgIssueLogKeyCollisionError(orderDeliveryId, collidedKey, e);
      }
      return MarkAttemptedResult.TRANSITIONED;
    }

    const current = await this.stateRepository.findOne({ where: { orderDeliveryId } });
    if (current?.state === SsgInsertState.CONFIRMED) {
      this.logger.warn(
        `markAttempted skipped (state=CONFIRMED, terminal): id=${orderDeliveryId}. caller가 기존 PIN 확인 단계를 건너뛰었을 가능성.`,
      );
      return MarkAttemptedResult.SKIPPED_TERMINAL;
    }
    this.logger.warn(
      `markAttempted skipped (state=ATTEMPTED, 미확정 시도 진행 중): id=${orderDeliveryId}. orphan resolver로 확정 후 재시도 필요.`,
    );
    return MarkAttemptedResult.SKIPPED_ACTIVE;
  }

  /**
   * Locks the command row in the same REQUIRES_NEW transaction that creates
   * ATTEMPTED/log state. A stale or missing owner therefore leaves no durable
   * candidate behind for a later HTTP recheck to reject.
   */
  private async lockCurrentConsumedIssueAuthority(authority: PinIssueCommandAuthority | undefined): Promise<boolean> {
    if (!authority) {
      return false;
    }

    const command = await this.stateRepository.manager
      .getRepository(PinIssueCommandEntity)
      .createQueryBuilder('command')
      .setLock('pessimistic_write')
      .where('command.id = :commandId', { commandId: authority.commandId })
      .andWhere('command.owner_token = :ownerToken', { ownerToken: authority.ownerToken })
      .andWhere('command.generation = :generation', { generation: authority.generation })
      .andWhere('command.workflow_version = :workflowVersion', { workflowVersion: authority.workflowVersion })
      .getOne();
    return hasConsumedSsgIssueAuthority(command);
  }
  /**
   * ATTEMPTED → CONFIRMED.
   *
   * state 전이 우선 (WHERE state=ATTEMPTED 가드). 전이 성공 시 order_delivery PIN 컬럼 best-effort 저장.
   * order_delivery 컬럼은 caller save()로 덮일 수 있으나, 신호(state)는 별 테이블에 무결.
   * 진실의 원천 PIN payload는 ssg_issue_log (markAttempted에서 이미 저장됨).
   *
   * 반환값: true = 전이 발생, false = silent skip (이미 CONFIRMED/FAILED 이거나 row 없음).
   * caller (특히 orphan resolver) 는 이 값으로 outcome을 정확히 분류해야 한다.
   */
  @Transactional({ propagation: Propagation.REQUIRES_NEW })
  async markConfirmed(orderDeliveryId: number, pinInfo: SsgConfirmInfo): Promise<boolean> {
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
      return false;
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
        ...(pinInfo.ssgEventId != null ? { ssgEventId: pinInfo.ssgEventId } : {}),
      })
      .where('id = :id', { id: orderDeliveryId })
      .execute();
    return true;
  }

  /**
   * ATTEMPTED → FAILED. state 만 전이 (실패에는 보존할 PIN 데이터 없음).
   * row 없음(NONE) / CONFIRMED 에서는 전이하지 않음 (state machine 엄격).
   *
   * 반환값: true = 전이 발생, false = silent skip.
   * caller (orphan resolver) 는 이 값으로 outcome을 정확히 분류해야 한다.
   */
  @Transactional({ propagation: Propagation.REQUIRES_NEW })
  async markFailed(orderDeliveryId: number): Promise<boolean> {
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
      return false;
    }
    return true;
  }

  /**
   * 현재 state 조회. row 없으면 NONE 반환 (Lazy 정책).
   */
  async getState(orderDeliveryId: number): Promise<SsgInsertState> {
    const row = await this.stateRepository.findOne({ where: { orderDeliveryId } });
    return row?.state ?? SsgInsertState.NONE;
  }

  /**
   * CONFIRMED state 인데 order_delivery 의 PIN 컬럼이 유실/무효된 경우, 진실의 원천인
   * ssg_issue_log(markAttempted 가 attempt 단위로 보존) 최신 usable row 로 order_delivery 를 복원한다.
   *
   * order_delivery.save() 가 stale 메모리 값으로 PIN 컬럼을 덮어쓸 수 있어(별 테이블 격리 정책의 배경),
   * state=CONFIRMED 인데 barCode 가 비는 상황이 가능하다. 재발송이 이 상태로 issue() 를 타면 새 PIN 생성 →
   * markAttempted SKIPPED_TERMINAL → SsgIssueAlreadyConfirmedError 로 stuck 되므로, 발송 전에 복원한다.
   *
   * @returns true = 복원 완료(usable row 존재), false = 복원 후보 없음(운영 점검 필요)
   */
  async restoreConfirmedPinFromIssueLog(orderDeliveryId: number): Promise<boolean> {
    const candidates = await this.issueLogRepository.find({
      where: { orderDeliveryId },
      order: { id: 'DESC' },
    });
    const usable = candidates.find((c) => c.eventSeq !== null && c.barCode !== null && c.personalCode !== null);
    if (!usable) {
      this.logger.warn(
        `[SSG_RESTORE] CONFIRMED PIN 복원 후보 없음 - orderDeliveryId=${orderDeliveryId}, candidates=${candidates.length}`,
      );
      return false;
    }

    await this.deliveryRepository
      .createQueryBuilder()
      .update(OrderDeliveryEntity)
      .set({
        barCode: usable.barCode,
        personalCode: usable.personalCode,
        ssgTransactionId: usable.ssgTransactionId,
        couponNum: usable.couponNum,
        expireAt: usable.expireAt,
        encourageAt: usable.encourageAt,
        ...(usable.ssgEventId != null ? { ssgEventId: usable.ssgEventId } : {}),
      })
      .where('id = :id', { id: orderDeliveryId })
      .execute();
    return true;
  }
}
