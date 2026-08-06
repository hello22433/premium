import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import {
  OrderDeliveryRefundEntity,
  OrderDeliveryRefundRestoreType,
  OrderDeliveryRefundSourcePath,
} from '../../entity/order.delivery.refund.entity';
import { RefundAttemptEntity } from '../../entity/refund.attempt.entity';
import { DeliveryCutoverGuardService, RefundExecutionFencing } from './delivery-cutover-guard.service';
import { LegacyDeliveryEntryPoint } from '../interface/legacy.delivery.entry.point';
import { REFUND_EXECUTING_STATUSES } from '../interface/refund.attempt.status';

export interface ClaimRefundInput {
  orderDeliveryId: number;
  userId: number;
  refundAmount: number;
  restoreType: OrderDeliveryRefundRestoreType;
  isSettleComplete: boolean;
  isSettleBalance: boolean;
  sourcePath: OrderDeliveryRefundSourcePath;
  operatorUserId?: number | null;
  memo?: string | null;
  /**
   * SSG 잔액 보정이 아직 안 끝났음을 표시. SSG 주문은 claim 시점에 true 로 줘서
   * `ssg_balance_settled=false` 로 INSERT 한다. resolver 가 RESTORED/SKIPPED_CONFIRMED 반환 시
   * `markSsgSettled()` 호출로 true 로 갱신. 비-SSG 주문이면 생략(기본 false → settled=true default).
   * plans/ssg-balance-refactor.md PR3 보강.
   */
  ssgPending?: boolean;
  /**
   * 이 claim 을 실행 중인 상위 `refund_attempt` 의 3중 fencing (§9 인벤토리 #12·§6.1).
   *
   * 컷오버 전환 건의 환불은 `refund_attempt` 단일 in-flight 가 상위 게이트이고, ledger claim 은 그
   * **하위 멱등 확인**으로 종속된다. id 하나로는 통과 증명이 되지 않으므로 `ownerToken`·`generation`·
   * `workflowVersion` 을 함께 받아, 가드가 attempt 와 현재 workflow 슬롯 소유자를 **한 쿼리로** 대조한다
   * (lease 를 뺏긴 stale worker 차단). 미전환 건은 이 값이 없어도 기존 경로 그대로 동작한다.
   */
  refundExecution?: RefundExecutionFencing & { externalIdempotencyKey: string };
}

/**
 * 환불 멱등성 락 서비스.
 *
 * order_delivery_refund 테이블의 UNIQUE 제약을 이용해 동일 발송건에 대한
 * 중복 환불을 구조적으로 차단한다. PIN 발급 dedup 테이블과 동일 패턴.
 *
 * - claim(): 환불 실행 직전 호출. 중복이면 BadRequestException throw + 호출자 환불 스킵.
 * - release(): 재발송 성공 시 호출. row DELETE → 재실패 시 다시 환불 가능.
 * - {claim,release}WithManager(): 명시적 queryRunner 트랜잭션 사용 path 용.
 */
@Injectable()
export class RefundLedgerService {
  private readonly logger = new Logger(RefundLedgerService.name);

  constructor(
    @InjectRepository(OrderDeliveryRefundEntity)
    private readonly refundRepository: Repository<OrderDeliveryRefundEntity>,
    @InjectRepository(OrderDeliveryEntity)
    private readonly deliveryRepository: Repository<OrderDeliveryEntity>,
    private readonly cutoverGuard: DeliveryCutoverGuardService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async findByAttempt(
    refundAttemptId: string,
    orderDeliveryId: number,
    amount: number,
  ): Promise<OrderDeliveryRefundEntity | null> {
    return await this.refundRepository.findOne({
      where: {
        refundAttemptId,
        orderDeliveryId,
        refundAmount: amount,
      },
    });
  }

  /**
   * 상위 게이트 확인 (§9 인벤토리 #12). 두 게이트(기존 ledger claim · 신규 `refund_attempt`)가
   * 서로를 모르는 구간을 남기지 않기 위한 종속이다.
   *
   * **id 를 넘겼다는 사실만으로는 통과시키지 않는다** — 임의의 값으로 legacy 환불 경로가 재개방되기
   * 때문이다. 가드가 attempt 의 소유(`order_delivery_id`)·실행 상태·`REFUND` 슬롯 보유에 더해
   * 3중 fencing(`ownerToken`·`generation`·`workflowVersion`)까지 한 쿼리로 대조한다.
   */
  private async assertUpstreamGate(input: ClaimRefundInput, manager?: EntityManager): Promise<void> {
    await this.cutoverGuard.assertRefundExecutionAllowed(
      {
        orderDeliveryId: input.orderDeliveryId,
        fencing: input.refundExecution,
        entryPoint: LegacyDeliveryEntryPoint.REFUND_LEDGER_CLAIM,
      },
      manager,
    );
  }

  async claim(input: ClaimRefundInput): Promise<void> {
    // 전환 건은 attempt 잠금 → 게이트 → INSERT 를 **한 트랜잭션**으로 묶는다.
    // 잠금이 INSERT 커밋까지 유지돼야 재조정이 "원장 부재"를 미실행 증거로 쓸 수 있다(lockExecutingAttempt 참고).
    if (input.refundExecution) {
      // `@Transactional()` 호출자 안이면 그 트랜잭션에 합류한다. `dataSource.transaction` 은
      // typeorm-transactional 이 항상 **독립 트랜잭션**으로 돌리므로, 여기서 그대로 쓰면
      // 호출자가 롤백해도 원장만 남는 divergence 가 생긴다.
      const ambient = this.refundRepository.manager as EntityManager | undefined;
      if (ambient?.queryRunner?.isTransactionActive) {
        await this.claimWithManager(ambient, input);
        return;
      }
      await this.dataSource.transaction(async (manager) => await this.claimWithManager(manager, input));
      return;
    }

    await this.assertUpstreamGate(input);
    await this.insertLedger(this.refundRepository, input);
    await this.markRefundedAt(this.deliveryRepository, input.orderDeliveryId);
  }

  async release(orderDeliveryId: number): Promise<void> {
    await this.deleteLedger(this.refundRepository, orderDeliveryId);
    await this.clearRefundedAt(this.deliveryRepository, orderDeliveryId);
  }

  /**
   * 환불 ledger row 존재 여부 확인.
   * order_delivery.refunded_at은 다른 save/update 흐름에서 NULL로 덮어쓰일 수 있어
   * 환불 발생 판정의 신뢰 가능한 단일 소스로 사용한다.
   */
  async exists(orderDeliveryId: number): Promise<boolean> {
    const count = await this.refundRepository.count({ where: { orderDeliveryId } });
    return count > 0;
  }

  /**
   * 현재 활성 환불 ledger row id 조회 (없으면 null).
   * claim 직후 동기적으로 호출해 "이 cycle 의 ledger id" 를 캡처하는 용도.
   * resolver→refundForDeliveryFail 에 명시 전달하면, 이후(orphan 네트워크 조회 등으로 지연된) 재조회가
   * release+재INSERT 된 다른 cycle 의 ledger 를 집어 멱등키를 오염시키는 것을 막는다(HIGH).
   */
  async getLedgerId(orderDeliveryId: number): Promise<number | null> {
    const row = await this.refundRepository.findOne({
      where: { orderDeliveryId },
      select: ['id'],
    });
    return row?.id ?? null;
  }

  /**
   * SSG 행사 잔액 보정 완료 여부 확인. ledger row 가 없으면 false 반환.
   * 재발송 가드에서 `exists() AND isSsgSettled()` 둘 다 통과해야 새 선차감 진행.
   * plans/ssg-balance-refactor.md PR3 보강.
   */
  async isSsgSettled(orderDeliveryId: number): Promise<boolean> {
    const row = await this.refundRepository.findOne({
      where: { orderDeliveryId },
      select: ['ssgBalanceSettled'],
    });
    return row?.ssgBalanceSettled ?? false;
  }

  /**
   * SSG resolver 가 RESTORED 또는 SKIPPED_CONFIRMED 반환 시 호출.
   * ledger row 의 `ssg_balance_settled` 를 true 로 갱신한다.
   * row 가 없으면 silently skip (정상 흐름이라면 claim 이 먼저 일어났어야 함).
   * plans/ssg-balance-refactor.md PR3 보강.
   *
   * @param recoverToken 전달 시 token-fenced: 본인 소유 lease(ssg_recover_token 일치) row 만 마킹.
   *   lease 만료/탈취된 stale holder 가 settled 를 마킹하는 것을 차단한다. 미전달 시 unconditional(동기 호출).
   */
  async markSsgSettled(orderDeliveryId: number, recoverToken?: string): Promise<void> {
    const qb = this.refundRepository
      .createQueryBuilder()
      .update(OrderDeliveryRefundEntity)
      .set({ ssgBalanceSettled: true })
      .where('order_delivery_id = :id', { id: orderDeliveryId });
    if (recoverToken != null) {
      qb.andWhere('ssg_recover_token = :tok', { tok: recoverToken });
    }
    const result = await qb.execute();
    if (!result.affected) {
      const fenceNote = recoverToken != null ? ' (token-fenced — lease 만료/탈취 가능성)' : '';
      this.logger.warn(`markSsgSettled: 대상 row 없음 (skip). orderDeliveryId=${orderDeliveryId}${fenceNote}`);
    }
  }

  async claimWithManager(manager: EntityManager, input: ClaimRefundInput): Promise<void> {
    await this.lockExecutingAttempt(manager, input);
    await this.assertUpstreamGate(input, manager);
    await this.insertLedger(manager.getRepository(OrderDeliveryRefundEntity), input);
    if (!input.refundExecution) {
      await this.markRefundedAt(manager.getRepository(OrderDeliveryEntity), input.orderDeliveryId);
    }
  }

  /**
   * 전환 건 ledger claim 의 **직렬화 지점**. `refund_attempt` 행을 잠금(현재) 읽기로 확정한다.
   *
   * 재조정(`RefundAttemptExecutorService.reconcile`)은 같은 행을 `FOR UPDATE` 로 잠그고 세대를 올린 뒤
   * "원장 부재 = 외부 미실행"을 확정한다. 이 잠금이 없으면 두 트랜잭션이 서로를 보지 못하고 엇갈린다.
   *   - 재조정이 먼저면: 여기서 세대 불일치를 보고 거부 → 살아남은 콜백도 환불을 커밋하지 못한다.
   *   - claim 이 먼저면: 재조정이 이 트랜잭션 커밋까지 대기 → 원장을 보고 FAILED 로 확정하지 않는다.
   * 즉 "실제 환불 성공 + attempt FAILED" 조합이 성립하지 않는다.
   *
   * 스냅샷(비잠금) 읽기로는 재조정이 이미 커밋한 세대를 볼 수 없어 대조 자체가 무의미하다.
   * 잠금 순서는 다른 경로와 동일하게 attempt → workflow 로 고정한다(교착 방지).
   */
  private async lockExecutingAttempt(manager: EntityManager, input: ClaimRefundInput): Promise<void> {
    const fencing = input.refundExecution;
    if (!fencing) {
      return;
    }

    const attempt = await manager.getRepository(RefundAttemptEntity).findOne({
      where: { id: fencing.refundAttemptId },
      lock: { mode: 'pessimistic_write' },
    });
    if (
      !attempt ||
      attempt.orderDeliveryId !== input.orderDeliveryId ||
      attempt.ownerToken !== fencing.ownerToken ||
      attempt.generation !== fencing.generation ||
      attempt.workflowVersion !== fencing.workflowVersion ||
      !REFUND_EXECUTING_STATUSES.includes(attempt.status)
    ) {
      this.logger.warn(
        `[REFUND_LEDGER] 세대가 회수된 실행의 claim 거부. ` +
          `orderDeliveryId=${input.orderDeliveryId}, refundAttemptId=${fencing.refundAttemptId}`,
      );
      throw new ConflictException({
        code: 'REFUND_EXECUTION_STALE',
        refundAttemptId: fencing.refundAttemptId,
        orderDeliveryId: input.orderDeliveryId,
      });
    }
  }

  async releaseWithManager(manager: EntityManager, orderDeliveryId: number): Promise<void> {
    await this.deleteLedger(manager.getRepository(OrderDeliveryRefundEntity), orderDeliveryId);
    await this.clearRefundedAt(manager.getRepository(OrderDeliveryEntity), orderDeliveryId);
  }

  private async insertLedger(repo: Repository<OrderDeliveryRefundEntity>, input: ClaimRefundInput): Promise<void> {
    try {
      await repo
        .createQueryBuilder()
        .insert()
        .into(OrderDeliveryRefundEntity)
        .values({
          orderDeliveryId: input.orderDeliveryId,
          userId: input.userId,
          refundAmount: input.refundAmount,
          restoreType: input.restoreType,
          isSettleComplete: input.isSettleComplete,
          isSettleBalance: input.isSettleBalance,
          sourcePath: input.sourcePath,
          operatorUserId: input.operatorUserId ?? null,
          memo: input.memo ?? null,
          refundAttemptId: input.refundExecution?.refundAttemptId ?? null,
          externalIdempotencyKey: input.refundExecution?.externalIdempotencyKey ?? null,
          // SSG 주문은 보정 완료 신호 false 로 시작 → resolver 성공 시 markSsgSettled 로 true.
          // 그 외 (비-SSG) 는 true (의미 없음, 가드에서 SSG type 분기로 영향 X).
          ssgBalanceSettled: !input.ssgPending,
        })
        .execute();
    } catch (e: any) {
      if (e?.code === 'ER_DUP_ENTRY' || e?.errno === 1062) {
        this.logger.warn(`환불 중복 차단: orderDeliveryId=${input.orderDeliveryId}, sourcePath=${input.sourcePath}`);
        throw new BadRequestException(`이미 환불된 발송건입니다. (orderDeliveryId: ${input.orderDeliveryId})`);
      }
      throw e;
    }
  }

  private async deleteLedger(repo: Repository<OrderDeliveryRefundEntity>, orderDeliveryId: number): Promise<void> {
    const result = await repo.delete({ orderDeliveryId });
    if (!result.affected) {
      this.logger.warn(`환불 해제 중복 차단: orderDeliveryId=${orderDeliveryId} (ledger row 없음)`);
      throw new BadRequestException(`이미 해제된 환불 ledger입니다. (orderDeliveryId: ${orderDeliveryId})`);
    }
  }

  private async markRefundedAt(repo: Repository<OrderDeliveryEntity>, orderDeliveryId: number): Promise<void> {
    await repo
      .createQueryBuilder()
      .update(OrderDeliveryEntity)
      .set({ refundedAt: () => 'CURRENT_TIMESTAMP(6)' })
      .where('id = :id', { id: orderDeliveryId })
      .execute();
  }

  private async clearRefundedAt(repo: Repository<OrderDeliveryEntity>, orderDeliveryId: number): Promise<void> {
    await repo.update({ id: orderDeliveryId }, { refundedAt: null });
  }
}
