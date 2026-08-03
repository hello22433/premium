import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ulid } from 'ulid';
import { OrderDeliveryRefundEntity } from '../../entity/order.delivery.refund.entity';
import { SsgRecoveryResult } from '../interface/ssg.recovery.result';
import { SsgRefundOutcome } from '../interface/ssg.refund.resolve';
import { SsgRefundResolverService } from './ssg-refund.resolver';
import { DeliveryCutoverGuardService, RefundExecutionFencing } from './delivery-cutover-guard.service';
import { LegacyDeliveryEntryPoint, notCutoverPredicate } from '../interface/legacy.delivery.entry.point';

/**
 * SSG 행사 잔액 복구의 단일 lease 게이트 진입점.
 * docs/plans/2026-06-12-external-api-wallet-integration.md B-0~B-7.
 *
 * 역할: sweep cron 과 "claim 밖 비동기 재시도" 가 같은 멱등 기반(B-6: refundForDeliveryFail 의
 * ssg_event_recovery_log refund_ledger_id UNIQUE)을 공유하도록 단일 진입점을 제공한다.
 *
 * 흐름:
 *   1) CAS token claim (원자): 한 actor 만 lease 를 소유. affected=0 → skip.
 *   2) lock 미보유로 resolver 호출 (money 안전은 B-6 가 보장 — 이중 행사잔액 복구 hard 차단).
 *   3) token-fenced escalation: attempts 임계 초과 시 1회만 escalated_at + logger.error 알림.
 *
 * markSsgSettled(=settled true) 처리는 resolver 가 RESTORED/SKIPPED_CONFIRMED 시 직접 수행한다.
 * DEFERRED 면 settled=false 유지 → lease 만료 후 sweep 이 재claim.
 */
@Injectable()
export class SsgRecoveryService {
  private readonly logger = new Logger(SsgRecoveryService.name);

  /** lease 기본 보유 시간(초). 최대 resolver 수행 시간보다 넉넉히 잡아 heartbeat 없이 만료 전 종료. */
  static readonly DEFAULT_LEASE_SECONDS = 120;

  /** 이 횟수를 초과하면 escalation(1회 알림) 대상. */
  static readonly ESCALATION_THRESHOLD = 10;

  constructor(
    @InjectRepository(OrderDeliveryRefundEntity)
    private readonly refundRepository: Repository<OrderDeliveryRefundEntity>,
    private readonly ssgRefundResolverService: SsgRefundResolverService,
    private readonly cutoverGuard: DeliveryCutoverGuardService,
  ) {}

  /**
   * lease 게이트를 통해 SSG 행사 잔액 복구를 시도한다.
   *
   * @param orderDeliveryId 복구 대상 발송건
   * @param ssgEventId      행사 id
   * @param orderId         주문 id
   * @param refundAmount    복구 금액 (order.sendAmount 스냅샷)
   * @param leaseSeconds    lease 보유 시간(초). 기본 DEFAULT_LEASE_SECONDS.
   */
  async recoverWithLease(
    orderDeliveryId: number,
    ssgEventId: number,
    orderId: number,
    refundAmount: number,
    leaseSeconds: number = SsgRecoveryService.DEFAULT_LEASE_SECONDS,
    refundExecution?: RefundExecutionFencing,
  ): Promise<SsgRecoveryResult> {
    if (refundExecution) {
      await this.cutoverGuard.assertRefundExecutionAllowed({
        orderDeliveryId,
        fencing: refundExecution,
        entryPoint: LegacyDeliveryEntryPoint.SSG_EVENT_REFUND,
      });
    } else {
      let cutover: boolean;
      try {
        cutover = await this.cutoverGuard.isCutover(orderDeliveryId);
      } catch (e) {
        this.logger.warn(
          `[SSG_RECOVERY] 컷오버 드레이닝 — legacy sweep 보류(다음 사이클 재시도). orderDeliveryId=${orderDeliveryId}: ${e}`,
        );
        return SsgRecoveryResult.SKIPPED_NO_CLAIM;
      }
      if (cutover) {
        this.logger.warn(
          `[SSG_RECOVERY] 컷오버 전환 건 — legacy sweep 건너뜀(RECONCILE 슬롯 경로 소관). orderDeliveryId=${orderDeliveryId}`,
        );
        return SsgRecoveryResult.SKIPPED_NO_CLAIM;
      }
    }

    const token = ulid();

    // 1) CAS token claim (원자). settled=false 이고 lease 미보유/만료인 row 만 소유.
    const claimQuery = this.refundRepository
      .createQueryBuilder()
      .update(OrderDeliveryRefundEntity)
      .set({
        ssgRecoverToken: token,
        ssgRecoverLeaseUntil: () => `NOW(6) + INTERVAL ${leaseSeconds} SECOND`,
        ssgRecoverAttempts: () => 'ssg_recover_attempts + 1',
      })
      .where('order_delivery_id = :odid', { odid: orderDeliveryId })
      .andWhere('ssg_balance_settled = false')
      .andWhere('(ssg_recover_lease_until IS NULL OR ssg_recover_lease_until < NOW(6))');
    if (!refundExecution) {
      claimQuery.andWhere(notCutoverPredicate('order_delivery_refund.order_delivery_id'));
    }
    const claim = await claimQuery.execute();

    if (!claim.affected) {
      // 다른 actor 가 lease 소유 중이거나 이미 settled → 복구 시도 안 함.
      return SsgRecoveryResult.SKIPPED_NO_CLAIM;
    }

    // 2) 방금 claim 한 row 의 id 를 token-fenced 로 읽는다 (멱등키). CAS UPDATE 는 PK 를 돌려주지 않으므로
    //    (order_delivery_id, ssg_recover_token) 로 본인 소유 row 를 SELECT. 이 id 를 refundForDeliveryFail 에
    //    명시 전달해 재조회로 인한 cross-cycle 멱등키 오염(HIGH-1)을 차단한다.
    const claimed = await this.refundRepository
      .createQueryBuilder('r')
      .select('r.id', 'id')
      .where('r.order_delivery_id = :odid', { odid: orderDeliveryId })
      .andWhere('r.ssg_recover_token = :tok', { tok: token })
      .getRawOne<{ id: string | number }>();

    if (!claimed) {
      // CAS 가 affected=1 로 성공했는데 token 으로 본인 row 를 못 읽음 = invariant 위반
      // (claim 직후 row 삭제/탈취). refundLedgerId=undefined 로 resolver 진입하면 refundForDeliveryFail 이
      // lookup fallback 으로 떨어져 cross-cycle 멱등키 오염(HIGH-1) 위험 → 진입 전 중단(DEFERRED).
      // settled=false 유지 → lease 만료 후 sweep 재claim.
      this.logger.error(
        `[SSG_RECOVERY] claim 직후 token-fenced ledger row 조회 실패 — resolver 진입 중단(DEFERRED). orderDeliveryId=${orderDeliveryId}, token=${token}`,
      );
      return SsgRecoveryResult.DEFERRED;
    }
    const refundLedgerId = Number(claimed.id);

    // 3) heartbeat: resolver 가 외부 SSG orphan 조회(네트워크) 로 길어질 수 있어, 수행 중 token-fenced 로
    //    lease 를 주기 연장한다. 만료 전 종료 가정에만 의존하지 않음 (HIGH-3).
    const heartbeat = this.startHeartbeat(orderDeliveryId, token, leaseSeconds);
    let outcome: SsgRefundOutcome;
    try {
      // resolver money 안전 = B-6 (refundForDeliveryFail 멱등 + 명시 refundLedgerId).
      // finalize(markSsgSettled) 는 token-fenced — lease 만료/탈취 시 settled 마킹 차단.
      outcome = await this.ssgRefundResolverService.resolveAndRefundIfNeeded({
        orderDeliveryId,
        ssgEventId,
        refundAmount,
        orderId,
        refundLedgerId,
        recoverToken: token,
        refundExecution,
      });
    } finally {
      clearInterval(heartbeat);
    }

    if (outcome === SsgRefundOutcome.DEFERRED) {
      // settled=false 유지 → lease 만료 후 재claim 대상. escalation 검토.
      await this.escalateIfNeeded(orderDeliveryId, token);
      return SsgRecoveryResult.DEFERRED;
    }

    if (outcome === SsgRefundOutcome.SKIPPED_CONFIRMED) {
      return SsgRecoveryResult.SKIPPED_CONFIRMED;
    }

    return SsgRecoveryResult.RESTORED;
  }

  /**
   * lease 연장 heartbeat. interval 마다 token-fenced(본인 소유) + settled=false row 의 lease_until 를 갱신.
   * settled 되거나 lease 를 잃으면 affected=0 → no-op (조용히 skip). 호출자는 반드시 clearInterval 로 정리.
   */
  private startHeartbeat(orderDeliveryId: number, token: string, leaseSeconds: number): NodeJS.Timeout {
    const intervalMs = Math.max(1, Math.floor((leaseSeconds * 1000) / 3));
    const timer = setInterval(() => {
      void this.refundRepository
        .createQueryBuilder()
        .update(OrderDeliveryRefundEntity)
        .set({ ssgRecoverLeaseUntil: () => `NOW(6) + INTERVAL ${leaseSeconds} SECOND` })
        .where('order_delivery_id = :odid', { odid: orderDeliveryId })
        .andWhere('ssg_recover_token = :tok', { tok: token })
        .andWhere('ssg_balance_settled = false')
        .execute()
        .catch((e) =>
          this.logger.warn(
            `[SSG_RECOVERY] heartbeat lease 연장 실패 (무시) — orderDeliveryId=${orderDeliveryId}, error: ${e instanceof Error ? e.message : e}`,
          ),
        );
    }, intervalMs);
    // 이벤트루프 점유 방지 (프로세스 종료 차단 안 함).
    timer.unref?.();
    return timer;
  }

  /**
   * attempts 가 임계를 초과하고 아직 escalated_at 이 없으면 1회만 escalated_at=NOW 세팅 + logger.error.
   * token-fenced(본인 소유 확인) + escalated_at IS NULL 가드로 재알림 안 함.
   */
  private async escalateIfNeeded(orderDeliveryId: number, token: string): Promise<void> {
    const result = await this.refundRepository
      .createQueryBuilder()
      .update(OrderDeliveryRefundEntity)
      .set({ ssgRecoverEscalatedAt: () => 'NOW(6)' })
      .where('order_delivery_id = :odid', { odid: orderDeliveryId })
      .andWhere('ssg_recover_token = :tok', { tok: token })
      .andWhere('ssg_recover_attempts > :threshold', {
        threshold: SsgRecoveryService.ESCALATION_THRESHOLD,
      })
      .andWhere('ssg_recover_escalated_at IS NULL')
      .execute();

    if (result.affected) {
      this.logger.error(
        `[SSG_RECOVERY] escalation — SSG 행사 잔액 복구가 임계(${SsgRecoveryService.ESCALATION_THRESHOLD})회 초과 DEFERRED. 운영 수동 점검 필요. orderDeliveryId=${orderDeliveryId}`,
      );
    }
  }
}
