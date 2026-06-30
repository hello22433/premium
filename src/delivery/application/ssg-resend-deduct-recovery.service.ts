import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ulid } from 'ulid';
import { SsgResendDeductPendingEntity } from '../../entity/ssg.resend.deduct.pending.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { SsgEventService } from '../../ssg_event/application/ssg.event.service';
import { SsgRefundResolverService } from './ssg-refund.resolver';
import { SsgRefundOutcome } from '../interface/ssg.refund.resolve';

/**
 * SSG 재발급 선차감 durable pending 복구 sweep (crash 복구).
 * plans/wip4-ssg-resend-deduct-durable.md.
 *
 * deductForReissueWithPending 로 선차감+pending 이 원자 커밋된 뒤, issue() 전/중 크래시로 caller 의
 * 정상 해소(resolveReissuePending)가 누락된 pending 을 자동 수렴시킨다.
 *
 * 후보: resolved_at IS NULL + lease 미보유/만료 + created_at >= SSG_SWEEP_MIGRATION_AT(시간격리)
 *       + created_at < NOW-GRACE(진행 중 정상 흐름 오복구 방지. 정상 재발급은 수초 내 해소됨).
 *
 * 각 후보를 CAS lease 로 단일 actor 가 점유 후 phase 분기:
 *  - issue_attempted_at IS NULL  → 외부 미등록 확정(W1) → refundResendEventDeduction 직접 역복원 → REVERSED.
 *    (기존 폐기 delivery 의 SSG state 를 보지 않음 — CONFIRMED 오판 차단.)
 *  - issue_attempted_at 존재      → resolver(state 기준, issue 대상 delivery) outcome:
 *      RESTORED          → REVERSED
 *      SKIPPED_CONFIRMED → order_delivery.ssg_event_id repair + KEPT
 *      DEFERRED          → 유지(lease 만료 후 재시도), 임계 초과 시 단발 escalation
 *
 * 멱등: refundResendEventDeduction(ssg_resend_deduct_recovery UNIQUE)이 once-only 보장 →
 *       caller 와 sweep 이중 역복원 없음.
 */
@Injectable()
export class SsgResendDeductRecoveryService {
  private readonly logger = new Logger(SsgResendDeductRecoveryService.name);

  /** 한 회 sweep 처리 후보 상한. */
  static readonly SWEEP_LIMIT = 100;
  /** lease 보유 시간(초). 외부 orphan 조회 포함 resolver 수행 시간보다 넉넉히. */
  static readonly LEASE_SECONDS = 180;
  /** 진행 중 정상 흐름 오복구 방지 grace(초). 이보다 오래 미해소 = 크래시 orphan. */
  static readonly GRACE_SECONDS = 600;
  /** 이 횟수 초과 시 단발 escalation. */
  static readonly ESCALATION_THRESHOLD = 10;

  constructor(
    @InjectRepository(SsgResendDeductPendingEntity)
    private readonly pendingRepository: Repository<SsgResendDeductPendingEntity>,
    @InjectRepository(OrderDeliveryEntity)
    private readonly orderDeliveryRepository: Repository<OrderDeliveryEntity>,
    private readonly ssgEventService: SsgEventService,
    private readonly ssgRefundResolverService: SsgRefundResolverService,
  ) {}

  async sweepOnce(): Promise<{
    candidates: number;
    reversed: number;
    kept: number;
    deferred: number;
    skipped: number;
  }> {
    const migrationAt = this.resolveMigrationAt();
    if (migrationAt === null) {
      this.logger.error(
        '[SSG_RESEND_SWEEP] SSG_SWEEP_MIGRATION_AT 미설정/파싱실패 — sweep 중단. 고정 ISO timestamp 환경변수 설정 필요.',
      );
      return { candidates: 0, reversed: 0, kept: 0, deferred: 0, skipped: 0 };
    }

    const candidates = await this.findCandidateIds(migrationAt);
    let reversed = 0;
    let kept = 0;
    let deferred = 0;
    let skipped = 0;

    for (const id of candidates) {
      try {
        const result = await this.recoverOne(id);
        if (result === 'REVERSED') reversed++;
        else if (result === 'KEPT') kept++;
        else if (result === 'DEFERRED') deferred++;
        else skipped++;
      } catch (e) {
        this.logger.error(
          `[SSG_RESEND_SWEEP] 후보 처리 예외 — skip. pendingId=${id}, error: ${e instanceof Error ? e.message : e}`,
        );
        skipped++;
      }
    }

    if (candidates.length) {
      this.logger.log(
        `[SSG_RESEND_SWEEP] 완료 — candidates=${candidates.length}, reversed=${reversed}, kept=${kept}, deferred=${deferred}, skipped=${skipped}`,
      );
    }
    return { candidates: candidates.length, reversed, kept, deferred, skipped };
  }

  /** 후보 pending id 목록(가벼운 SELECT). 개별 경쟁은 recoverOne 의 CAS claim 으로 해소. */
  private async findCandidateIds(migrationAt: Date): Promise<number[]> {
    const rows = await this.pendingRepository
      .createQueryBuilder('p')
      .select('p.id', 'id')
      .where('p.resolved_at IS NULL')
      .andWhere('(p.recover_lease_until IS NULL OR p.recover_lease_until < NOW(6))')
      .andWhere('p.created_at >= :migrationAt', { migrationAt })
      .andWhere(`p.created_at < NOW(6) - INTERVAL ${SsgResendDeductRecoveryService.GRACE_SECONDS} SECOND`)
      .orderBy('p.id', 'ASC')
      .limit(SsgResendDeductRecoveryService.SWEEP_LIMIT)
      .getRawMany<{ id: string | number }>();
    return rows.map((r) => Number(r.id));
  }

  private async recoverOne(pendingId: number): Promise<'REVERSED' | 'KEPT' | 'DEFERRED' | 'SKIPPED'> {
    const token = ulid();

    // 1) CAS lease claim. resolved_at IS NULL + lease 미보유/만료인 row 만 소유.
    const claim = await this.pendingRepository
      .createQueryBuilder()
      .update(SsgResendDeductPendingEntity)
      .set({
        recoverToken: token,
        recoverLeaseUntil: () => `NOW(6) + INTERVAL ${SsgResendDeductRecoveryService.LEASE_SECONDS} SECOND`,
        recoverAttempts: () => 'recover_attempts + 1',
      })
      .where('id = :id', { id: pendingId })
      .andWhere('resolved_at IS NULL')
      .andWhere('(recover_lease_until IS NULL OR recover_lease_until < NOW(6))')
      .execute();

    if (!claim.affected) {
      // 다른 actor 가 점유 중이거나 이미 해소됨.
      return 'SKIPPED';
    }

    const row = await this.pendingRepository.findOne({ where: { id: pendingId, recoverToken: token } });
    if (!row) {
      // claim 직후 토큰 row 조회 실패 = 탈취/해소. 다음 주기 재시도.
      return 'SKIPPED';
    }

    const heartbeat = this.startHeartbeat(pendingId, token);
    try {
      if (row.issueAttemptedAt == null) {
        // W1: issue 미시도 → 외부 미등록 확정 → 직접 역복원. (state 보지 않음)
        await this.ssgEventService.refundResendEventDeduction({
          resendDeductionId: row.resendDeductionId,
          ssgEventId: row.ssgEventId,
          orderId: row.orderId,
          amount: row.amount,
        });
        await this.ssgEventService.resolveReissuePending(row.resendDeductionId, 'REVERSED');
        return 'REVERSED';
      }

      if (row.issueOutcome === 'REUSED') {
        // issue() 가 기존/후보 PIN 을 재사용해 선차감 행사를 미사용함(durable 마킹). 재사용 PIN 의 CONFIRMED
        // state 를 새 행사 등록으로 오판하지 않도록, state 와 무관하게 선차감을 직접 역복원한다(이중차감 방지).
        await this.ssgEventService.refundResendEventDeduction({
          resendDeductionId: row.resendDeductionId,
          ssgEventId: row.ssgEventId,
          orderId: row.orderId,
          amount: row.amount,
        });
        await this.ssgEventService.resolveReissuePending(row.resendDeductionId, 'REVERSED');
        return 'REVERSED';
      }

      if (row.issueOrderDeliveryId == null) {
        // 방어: issue 시도됐다는데 대상 delivery id 가 없으면 안전 확정 불가 → 유지.
        this.logger.error(
          `[SSG_RESEND_SWEEP] issue 시도됨이나 issue_order_delivery_id 없음 — 유지. pendingId=${pendingId}`,
        );
        await this.escalateIfNeeded(pendingId, token);
        return 'DEFERRED';
      }

      // issue 시도됨 → 실제 issue 대상 delivery 의 SSG state 기준 확정.
      const outcome = await this.ssgRefundResolverService.resolveAndRefundIfNeeded({
        orderDeliveryId: row.issueOrderDeliveryId,
        ssgEventId: row.ssgEventId,
        refundAmount: row.amount,
        orderId: row.orderId,
        resendDeductionId: row.resendDeductionId,
      });

      if (outcome === SsgRefundOutcome.RESTORED) {
        await this.ssgEventService.resolveReissuePending(row.resendDeductionId, 'REVERSED');
        return 'REVERSED';
      }
      if (outcome === SsgRefundOutcome.SKIPPED_CONFIRMED) {
        // CONFIRMED: 외부는 새 행사로 등록 확정 — DB delivery 의 ssg_event_id 를 repair(불일치 시).
        await this.orderDeliveryRepository
          .createQueryBuilder()
          .update(OrderDeliveryEntity)
          .set({ ssgEventId: row.ssgEventId })
          .where('id = :id', { id: row.issueOrderDeliveryId })
          .andWhere('(ssg_event_id IS NULL OR ssg_event_id <> :eid)', { eid: row.ssgEventId })
          .execute();
        await this.ssgEventService.resolveReissuePending(row.resendDeductionId, 'KEPT');
        return 'KEPT';
      }

      // DEFERRED: 불명 → 유지(lease 만료 후 재시도). 임계 초과 시 escalation.
      await this.escalateIfNeeded(pendingId, token);
      return 'DEFERRED';
    } finally {
      clearInterval(heartbeat);
    }
  }

  private startHeartbeat(pendingId: number, token: string): NodeJS.Timeout {
    const intervalMs = Math.max(1, Math.floor((SsgResendDeductRecoveryService.LEASE_SECONDS * 1000) / 3));
    const timer = setInterval(() => {
      void this.pendingRepository
        .createQueryBuilder()
        .update(SsgResendDeductPendingEntity)
        .set({ recoverLeaseUntil: () => `NOW(6) + INTERVAL ${SsgResendDeductRecoveryService.LEASE_SECONDS} SECOND` })
        .where('id = :id', { id: pendingId })
        .andWhere('recover_token = :tok', { tok: token })
        .andWhere('resolved_at IS NULL')
        .execute()
        .catch((e) =>
          this.logger.warn(
            `[SSG_RESEND_SWEEP] heartbeat 연장 실패(무시) — pendingId=${pendingId}, error: ${e instanceof Error ? e.message : e}`,
          ),
        );
    }, intervalMs);
    timer.unref?.();
    return timer;
  }

  private async escalateIfNeeded(pendingId: number, token: string): Promise<void> {
    const result = await this.pendingRepository
      .createQueryBuilder()
      .update(SsgResendDeductPendingEntity)
      .set({ recoverEscalatedAt: () => 'NOW(6)' })
      .where('id = :id', { id: pendingId })
      .andWhere('recover_token = :tok', { tok: token })
      .andWhere('recover_attempts > :threshold', { threshold: SsgResendDeductRecoveryService.ESCALATION_THRESHOLD })
      .andWhere('recover_escalated_at IS NULL')
      .execute();

    if (result.affected) {
      this.logger.error(
        `[SSG_RESEND_SWEEP] escalation — 재발급 선차감 복구가 임계(${SsgResendDeductRecoveryService.ESCALATION_THRESHOLD})회 초과 DEFERRED. 운영 점검 필요. pendingId=${pendingId}`,
      );
    }
  }

  /**
   * SSG_SWEEP_MIGRATION_AT(고정 ISO) 이전 backlog 제외. 미설정/파싱실패 시 null → sweep 중단.
   * 기존 SSG 복구 sweep 과 동일 환경변수 공유.
   */
  private resolveMigrationAt(): Date | null {
    const raw = process.env.SSG_SWEEP_MIGRATION_AT?.trim();
    if (!raw) return null;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      this.logger.error(`[SSG_RESEND_SWEEP] SSG_SWEEP_MIGRATION_AT 파싱 실패('${raw}') — sweep 중단.`);
      return null;
    }
    return parsed;
  }
}
