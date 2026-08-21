import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { EntityManager, Repository } from 'typeorm';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { OrderDeliveryRefundEntity } from '../../entity/order.delivery.refund.entity';
import { PinIssueCommandEntity } from '../../entity/pin.issue.command.entity';
import { SsgEventEntity } from '../../entity/ssg.event.entity';
import { SsgIssueLogEntity } from '../../entity/ssg.issue.log.entity';
import { PartnerCompanyExternService, SsgDeferredClassification } from '../../partner_company_extern/application/partner.company.extern.service';
import { SsgPinResolution } from '../../partner_company_extern/interface/ssg.issue';
import {
  canExecuteOrdinal,
  computeResolutionBackoffMs,
  computeResolutionDeadline,
  SSG_NOT_ISSUED_STREAK_THRESHOLD,
} from '../../partner_company_extern/domain/ssg.autoresolve.policy';
import { SsgAutoResolveConfig } from '../../partner_company_extern/application/ssg.autoresolve.config';
import { IOrderDeliveryStatus } from '../interface/order.delivery.status';
import { PIN_ISSUE_AUTOMATED_TRANSITION_STATUSES, PinIssueCommandStatus } from '../interface/pin.issue.command.status';
import { SsgRecoveryResult } from '../interface/ssg.recovery.result';
import { PinIssueCommandAuthority, PinIssueCommandService } from './pin-issue-command.service';
import { SsgRecoveryService } from './ssg-recovery.service';

/**
 * sweep 후보 1건. migration 격리 + lease 게이트로 자동 수렴시킬 DEFERRED SSG 복구 backlog.
 */
interface SsgSweepCandidate {
  orderDeliveryId: number;
  ssgEventId: number;
  orderId: number;
  refundAmount: number;
}

/**
 * SSG 행사 잔액 복구 sweep.
 * docs/plans/2026-06-12-external-api-wallet-integration.md B-7.
 *
 * 후보: ssg_balance_settled=false 이고 lease 미보유/만료인 SSG 환불 ledger 중
 *       refunded_at >= migrationAt (시간 격리, B-7 기본정책 — 그 이전 backlog 는 제외).
 * 각 후보를 recoverWithLease 로 처리해 sweep 과 실시간이 같은 멱등 기반(B-6)을 공유한다.
 *
 * refundAmount = order.sendAmount(스냅샷), product.price 아님.
 */
@Injectable()
export class SsgRecoverySweepService {
  private readonly logger = new Logger(SsgRecoverySweepService.name);

  /** 한 회 sweep 처리 후보 상한. */
  static readonly SWEEP_LIMIT = 100;

  constructor(
    @InjectRepository(OrderDeliveryRefundEntity)
    private readonly refundRepository: Repository<OrderDeliveryRefundEntity>,
    @InjectRepository(PinIssueCommandEntity)
    private readonly pinIssueCommandRepository: Repository<PinIssueCommandEntity>,
    @InjectRepository(OrderDeliveryEntity)
    private readonly orderDeliveryRepository: Repository<OrderDeliveryEntity>,
    @InjectRepository(SsgEventEntity)
    private readonly ssgEventRepository: Repository<SsgEventEntity>,
    @InjectRepository(SsgIssueLogEntity)
    private readonly ssgIssueLogRepository: Repository<SsgIssueLogEntity>,
    private readonly ssgRecoveryService: SsgRecoveryService,
    private readonly pinIssueCommandService: PinIssueCommandService,
    private readonly partnerCompanyExternService: PartnerCompanyExternService,
    private readonly autoResolveConfig: SsgAutoResolveConfig,
  ) {}

  /**
   * migrationAt 이후 backlog 만 대상으로 한 회 sweep.
   * @returns 처리(claim 소유 후 resolver 호출) 시도한 후보 수 통계.
   */
  async sweepOnce(): Promise<{ candidates: number; restored: number; deferred: number; skipped: number }> {
    const migrationAt = this.resolveMigrationAt();
    if (migrationAt === null) {
      // cutoff 미설정/파싱실패 → sweep 중단. new Date() fallback 은 신규 ledger 까지 영구 제외(영구 no-op)하므로 금지.
      this.logger.error(
        '[SSG_SWEEP] SSG_SWEEP_MIGRATION_AT 미설정/파싱실패 — sweep 중단. ' +
          '고정 ISO timestamp 환경변수 설정 필요 (미설정 시 backlog 자동 수렴 안 됨).',
      );
      return { candidates: 0, restored: 0, deferred: 0, skipped: 0 };
    }
    const candidates = await this.findCandidates(migrationAt);

    let restored = 0;
    let deferred = 0;
    let skipped = 0;

    for (const c of candidates) {
      try {
        const result = await this.ssgRecoveryService.recoverWithLease(
          c.orderDeliveryId,
          c.ssgEventId,
          c.orderId,
          c.refundAmount,
        );
        if (result === SsgRecoveryResult.RESTORED || result === SsgRecoveryResult.SKIPPED_CONFIRMED) {
          restored++;
        } else if (result === SsgRecoveryResult.DEFERRED) {
          deferred++;
        } else {
          // SKIPPED_NO_CLAIM: 다른 actor 가 lease 보유 중 — 다음 주기에 재시도됨.
          skipped++;
        }
      } catch (e) {
        // recoverWithLease 자체는 resolver 예외를 흡수하지만, claim UPDATE 등 인프라 예외는
        // 한 후보 실패가 sweep 전체를 막지 않도록 흡수한다 (다음 주기 재시도).
        this.logger.error(
          `[SSG_SWEEP] 후보 처리 예외 — skip. orderDeliveryId=${c.orderDeliveryId}, error: ${e instanceof Error ? e.message : e}`,
        );
        skipped++;
      }
    }

    if (candidates.length) {
      this.logger.log(
        `[SSG_SWEEP] 완료 — candidates=${candidates.length}, restored=${restored}, deferred=${deferred}, skipped=${skipped}`,
      );
    }
    return { candidates: candidates.length, restored, deferred, skipped };
  }

  /**
   * sweep 후보 조회. SSG 주문 + lease 미보유/만료 + 시간 격리.
   * refundAmount 는 order.sendAmount 스냅샷.
   */
  private async findCandidates(migrationAt: Date): Promise<SsgSweepCandidate[]> {
    const rows = await this.refundRepository
      .createQueryBuilder('r')
      .innerJoin('order_delivery', 'd', 'd.id = r.order_delivery_id AND d.ssg_event_id IS NOT NULL')
      .innerJoin('order_product_mapping', 'opm', 'opm.id = d.order_product_mapping_id')
      .innerJoin('order', 'o', "o.id = opm.order_id AND o.type = 'SSG'")
      .select('r.order_delivery_id', 'orderDeliveryId')
      .addSelect('d.ssg_event_id', 'ssgEventId')
      .addSelect('o.id', 'orderId')
      .addSelect('o.send_amount', 'refundAmount')
      .where('r.ssg_balance_settled = false')
      .andWhere('(r.ssg_recover_lease_until IS NULL OR r.ssg_recover_lease_until < NOW(6))')
      .andWhere('r.refunded_at >= :migrationAt', { migrationAt })
      .orderBy('r.id', 'ASC')
      .limit(SsgRecoverySweepService.SWEEP_LIMIT)
      .getRawMany();

    return rows.map((row) => ({
      orderDeliveryId: Number(row.orderDeliveryId),
      ssgEventId: Number(row.ssgEventId),
      orderId: Number(row.orderId),
      refundAmount: Number(row.refundAmount),
    }));
  }

  /**
   * SSG_SWEEP_MIGRATION_AT(고정 ISO 문자열) 이전 backlog 는 sweep 제외 (시간 격리).
   *
   * 미설정/파싱실패 시 null 반환 → caller(sweepOnce)가 sweep 중단.
   * new Date() fallback 을 쓰면 매 실행 cutoff 가 "지금"으로 밀려 신규 ledger 까지 영구 제외(sweep 영구 no-op)되므로,
   * 반드시 운영에서 고정 timestamp 를 설정해야 한다.
   */
  private resolveMigrationAt(): Date | null {
    const raw = process.env.SSG_SWEEP_MIGRATION_AT?.trim();
    if (!raw) return null;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      this.logger.error(`[SSG_SWEEP] SSG_SWEEP_MIGRATION_AT 파싱 실패('${raw}') — sweep 중단.`);
      return null;
    }
    return parsed;
  }
  /**
   * Resolves deferred SSG INSERT commands. This is deliberately resolution-only:
   * only a proved NOT_ISSUED result may consume the single retry authority; no
   * unknown result reaches issue, send, or refund.
   */
  async resolvePinIssuesOnce(): Promise<{
    candidates: number;
    confirmed: number;
    retryPending: number;
    opsReview: number;
    skipped: number;
  }> {
    const now = new Date();
    const candidates = await this.findDuePinCommands(now);
    let confirmed = 0;
    let retryPending = 0;
    let opsReview = 0;
    let skipped = 0;

    for (const candidate of candidates) {
      // §9-3: commandTransition 미허용이면 durable 변경 금지 — claim 시도 자체를 건너뛴다.
      const capability = this.autoResolveConfig.capabilityFor(candidate);
      if (!capability.commandTransition) {
        skipped++;
        continue;
      }

      // 후보마다 claim 시점의 새 시각을 쓴다. 100개까지 외부 조회·INSERT 를 순차 실행하므로,
      // sweep 시작 now 를 재사용하면 뒤 후보의 lease_expires_at(now+5분)·rotate 토큰이 claim 하는
      // 순간 이미 만료돼 다른 worker 가 즉시 재회수 → fencing 이 깨진다.
      const attemptAt = new Date();
      const claim = await this.claimPinCommand(candidate, attemptAt);
      if (!claim) {
        // EP-P30 §7-1: claimPinCommand 실패 = delivery claim CAS 불일치(앱 재시작 후 NULL 로 풀림).
        // NOT_ATTEMPTED 이면 권한 재점유 + claim 재획득으로 frozen command 를 복구한다.
        let notAttemptedResult: 'confirmed' | 'ops_review' | null;
        try {
          notAttemptedResult = await this.tryRecoverFromClaimFailure(candidate, attemptAt);
        } catch (recoverError) {
          this.logger.error(
            `[PIN_RESOLUTION_SWEEP] tryRecoverFromClaimFailure threw for command=${candidate.id}: ${recoverError instanceof Error ? recoverError.message : recoverError}`,
          );
          skipped++;
          continue;
        }
        if (notAttemptedResult === 'confirmed') {
          confirmed++;
        } else if (notAttemptedResult === 'ops_review') {
          opsReview++;
        } else {
          skipped++;
        }
        continue;
      }
      // batch 명령은 claim 시 delivery mutation lease 를 새 토큰으로 갱신했다. 이후 발급·완료는
      // 반드시 그 갱신된 토큰으로만 진행해야 CS·폐기 경합에서 delivery 를 놓치지 않는다.
      const { authority, deliveryClaimToken } = claim;

      try {
        // A command without its delivery can never safely be retried.
        const delivery = await this.orderDeliveryRepository.findOne({
          where: { id: candidate.orderDeliveryId },
          relations: { orderProductMapping: { product: { partnerCompany: true } } },
        });
        if (!delivery) {
          if (
            await this.recordResolution(authority, SsgPinResolution.UNKNOWN, PinIssueCommandStatus.OPS_REVIEW_REQUIRED, null, null, candidate.resolutionLookupCount)
          ) {
            opsReview++;
          } else {
            skipped++;
          }
          continue;
        }

        // ISO delivery claim이 없는 STARTED 명령은 external API·CS·재발송 등 caller별 후속 처리와
        // 회계 문맥을 복원할 수 없다. generic sweep이 PIN만 발급하거나 재등록하면 발송 누락,
        // 잘못된 행사 사용 또는 선차감 불일치가 생기므로 운영 확인으로 닫는다.
        if (candidate.status === PinIssueCommandStatus.STARTED && !deliveryClaimToken) {
          if (
            await this.recordResolution(authority, SsgPinResolution.UNKNOWN, PinIssueCommandStatus.OPS_REVIEW_REQUIRED, null, null, candidate.resolutionLookupCount)
          ) {
            opsReview++;
          } else {
            skipped++;
          }
          continue;
        }

        // §7-3 마감 산출 (최초 진입 시 1회). 모든 외부 호출/종결 분기 전에 검사한다.
        let deadline: Date | null;
        try {
          deadline = await this.computeDeadlineForCommand(candidate, delivery);
        } catch (deadlineError) {
          this.logger.error(
            `[PIN_RESOLUTION_SWEEP] deadline computation infra error command=${candidate.id}, skipping: ${deadlineError instanceof Error ? deadlineError.message : deadlineError}`,
          );
          skipped++;
          continue;
        }

        // §7-3 산출 즉시 durable 저장 — 외부 호출 전에 저장해야 장애 시 재계산 방지.
        if (deadline && !candidate.resolutionDeadlineAt) {
          if (!(await this.persistDeadline(authority, deadline))) {
            skipped++;
            continue;
          }
        }

        // §7-3 산출 불가 → 즉시 OPS (expireDay 미설정 등 — 영구 비활성화 방지).
        if (!deadline && !candidate.resolutionDeadlineAt) {
          if (
            await this.promoteOpsReviewWithClaimRelease(
              authority,
              candidate.resolution ?? SsgPinResolution.UNKNOWN,
              delivery.id,
              deliveryClaimToken,
              'DEADLINE_UNCOMPUTABLE',
            )
          ) {
            opsReview++;
          } else {
            skipped++;
          }
          continue;
        }

        // §7-3 마감 도달 검사 (이미 저장된 값 우선, 없으면 방금 산출한 값).
        const effectiveDeadline = candidate.resolutionDeadlineAt ?? deadline;
        if (effectiveDeadline && attemptAt >= effectiveDeadline) {
          if (
            await this.promoteOpsReviewWithClaimRelease(
              authority,
              candidate.resolution ?? SsgPinResolution.UNKNOWN,
              delivery.id,
              deliveryClaimToken,
              'DEADLINE_EXCEEDED',
            )
          ) {
            opsReview++;
          } else {
            skipped++;
          }
          continue;
        }

        // crash/lease 회수: STARTED·count=0 은 최초 INSERT 권한을 아직 소비하지 않았으므로 SSG 호출이
        // 확정적으로 없었다. 재조회가 아니라 최초 발급을 이어서 수행한다(권한 소비 0→1 후 issue).
        // count=1 이상은 아래 resolver 경로로 흘러 실제 SSG 상태로만 판정한다(재발급 금지).
        if (candidate.status === PinIssueCommandStatus.STARTED && candidate.externalIssueCount === 0) {
          if (!canExecuteOrdinal(capability, 1).allowed) {
            if (
              await this.promoteOpsReviewWithClaimRelease(
                authority,
                candidate.resolution ?? SsgPinResolution.UNKNOWN,
                delivery.id,
                deliveryClaimToken,
                'ORDINAL_1_GATE_CLOSED',
              )
            ) {
              opsReview++;
            } else {
              skipped++;
            }
            continue;
          }
          if (await this.executeInitialIssue(authority, delivery, deliveryClaimToken)) {
            confirmed++;
          } else {
            skipped++;
          }
          continue;
        }

        // A count-2 NOT_ISSUED command has already consumed its sole INSERT
        // authority. Reclaiming an expired resolver lease must query only:
        // confirmed results release the original delivery claim; every other
        // result is retained for operator review.
        if (candidate.externalIssueCount === 2 && candidate.resolution === SsgPinResolution.NOT_ISSUED) {
          const { resolution, confirmedCandidate } = await this.partnerCompanyExternService.classifyDeferredSsgIssue(delivery.id);
          const postLookupAt = new Date();
          if (resolution === SsgPinResolution.CONFIRMED) {
            if (effectiveDeadline && postLookupAt >= effectiveDeadline) {
              if (
                await this.promoteOpsReviewWithClaimRelease(
                  authority,
                  SsgPinResolution.CONFIRMED,
                  delivery.id,
                  deliveryClaimToken,
                  'CONFIRMED_AFTER_DEADLINE',
                )
              ) {
                opsReview++;
              } else {
                skipped++;
              }
            } else if (await this.completeConfirmedCommandWithApply(authority, delivery, deliveryClaimToken, confirmedCandidate ?? null)) {
              confirmed++;
            } else {
              skipped++;
            }
          } else if (await this.recordResolution(authority, resolution, PinIssueCommandStatus.OPS_REVIEW_REQUIRED, null, null, candidate.resolutionLookupCount)) {
            opsReview++;
          } else {
            skipped++;
          }
          continue;
        }

        const { resolution, confirmedCandidate } = await this.partnerCompanyExternService.classifyDeferredSsgIssue(delivery.id);
        const postLookupAt = new Date();
        const backoffMs = computeResolutionBackoffMs(candidate.resolutionStartedAt, postLookupAt);
        const nextAttemptAt = new Date(postLookupAt.getTime() + backoffMs);

        if (resolution === SsgPinResolution.CONFIRMED) {
          // §7-3 만료 후보 차단 — 조회 완료 후 시각으로 검사해 조회 도중 만료를 감지한다.
          if (effectiveDeadline && postLookupAt >= effectiveDeadline) {
            if (
              await this.promoteOpsReviewWithClaimRelease(
                authority,
                SsgPinResolution.CONFIRMED,
                delivery.id,
                deliveryClaimToken,
                'CONFIRMED_AFTER_DEADLINE',
              )
            ) {
              opsReview++;
            } else {
              skipped++;
            }
          } else if (await this.completeConfirmedCommandWithApply(authority, delivery, deliveryClaimToken, confirmedCandidate ?? null)) {
            confirmed++;
          } else {
            skipped++;
          }
        } else if (resolution === SsgPinResolution.LOOKUP_FAILED) {
          // §6-B: 조회 실패 → claim 해제 + RETRY_PENDING + 경과시간 백오프.
          if (
            await this.pinIssueCommandService.releaseClaimForRetryPending(
              authority,
              delivery.id,
              deliveryClaimToken,
              { resolution, nextAttemptAt, resolutionDeadlineAt: deadline, expectedLookupCount: candidate.resolutionLookupCount },
            )
          ) {
            retryPending++;
          } else {
            skipped++;
          }
        } else if (resolution === SsgPinResolution.NOT_ISSUED) {
          // §6-C: dead(tryYn='N') → streak+1 + claim 해제 + 백오프.
          // streak 이 임계에 도달하면 NOT_ISSUED 확정. P3 gate 가 열려 있으면 재발급으로 이동.
          const streakAfter = candidate.notIssuedStreak + 1;
          const streakConfirmed = streakAfter >= SSG_NOT_ISSUED_STREAK_THRESHOLD;

          if (
            streakConfirmed &&
            candidate.externalIssueCount === 1 &&
            canExecuteOrdinal(this.autoResolveConfig.capabilityFor(candidate), 2).allowed
          ) {
            // P3 gate open — streak 확정 + 재발급 진입.
            const recorded = await this.recordResolution(authority, resolution, PinIssueCommandStatus.RETRYING, null, deadline, candidate.resolutionLookupCount);
            if (!recorded || !(await this.pinIssueCommandService.consumeNotIssuedRetryAuthority(authority))) {
              skipped++;
              continue;
            }
            if (await this.executeNotIssuedRetry(authority, delivery, deliveryClaimToken)) {
              retryPending++;
            } else {
              skipped++;
            }
          } else {
            // P3 gate closed 또는 streak 미도달 → claim 해제 + RETRY_PENDING + 백오프.
            if (
              await this.pinIssueCommandService.releaseClaimForRetryPending(
                authority,
                delivery.id,
                deliveryClaimToken,
                { resolution, nextAttemptAt, resolutionDeadlineAt: deadline, expectedLookupCount: candidate.resolutionLookupCount },
              )
            ) {
              retryPending++;
            } else {
              skipped++;
            }
          }
        } else if (resolution === SsgPinResolution.PROCESSING) {
          // 아직 협력사 처리 중 → 백오프 재조회.
          if (
            await this.pinIssueCommandService.releaseClaimForRetryPending(
              authority,
              delivery.id,
              deliveryClaimToken,
              { resolution, nextAttemptAt, resolutionDeadlineAt: deadline, expectedLookupCount: candidate.resolutionLookupCount },
            )
          ) {
            retryPending++;
          } else {
            skipped++;
          }
        } else {
          // UNKNOWN, REGISTERED_UNSENDABLE, NOT_ATTEMPTED, MULTIPLE_CONFIRMED → 운영 확인.
          if (await this.recordResolution(authority, resolution, PinIssueCommandStatus.OPS_REVIEW_REQUIRED, null, deadline, candidate.resolutionLookupCount)) {
            opsReview++;
          } else {
            skipped++;
          }
        }
      } catch (error) {
        // Lookup failure is indistinguishable from an unknown external outcome.
        if (
          await this.recordResolution(authority, SsgPinResolution.UNKNOWN, PinIssueCommandStatus.OPS_REVIEW_REQUIRED, null, null, candidate.resolutionLookupCount)
        ) {
          opsReview++;
        } else {
          skipped++;
        }
        this.logger.error(
          `[PIN_RESOLUTION_SWEEP] command=${candidate.id} resolution failed: ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    return { candidates: candidates.length, confirmed, retryPending, opsReview, skipped };
  }

  private async findDuePinCommands(now: Date): Promise<PinIssueCommandEntity[]> {
    return this.pinIssueCommandRepository
      .createQueryBuilder('c')
      .where(
        `(
          c.status = :retryPending
          AND (c.next_attempt_at IS NULL OR c.next_attempt_at <= :now)
          AND (c.lease_expires_at IS NULL OR c.lease_expires_at < :now)
        ) OR (
          c.status = :retrying
          AND c.lease_expires_at < :now
        ) OR (
          -- crash/lease 회수: STARTED 로 영구 잔류한 명령(권한 소비 전 count=0, 소비 후 SSG 미확정 count=1)을
          -- 회수한다. 미회수 시 활성 fence 로 재발송·일반 배치가 영구 차단된다. lease_expires_at 이 없는
          -- (컬럼 신설 전 backfill 안 된) 레거시 STARTED 행도 NULL 조건으로 함께 회수 대상에 넣는다.
          c.status = :started
          AND (c.lease_expires_at IS NULL OR c.lease_expires_at < :now)
        )`,
        {
          retryPending: PinIssueCommandStatus.RETRY_PENDING,
          retrying: PinIssueCommandStatus.RETRYING,
          started: PinIssueCommandStatus.STARTED,
          now,
        },
      )
      .orderBy('c.next_attempt_at', 'ASC')
      .limit(SsgRecoverySweepService.SWEEP_LIMIT)
      .getMany();
  }

  /**
   * Claim with a fresh owner token and generation. The former owner can no
   * longer satisfy every later CAS predicate, including after a crash lease.
   *
   * batch 명령(유효 ISO delivery_claim_token 보유)은 command 만 회수하면 안 된다. 원래 배치
   * worker 가 죽고 delivery mutation lease 가 만료되면 그 사이 CS·폐기 actor 가 delivery 를 탈취해
   * 상태를 바꿀 수 있는데, sweep 이 그 위에서 외부 INSERT 를 실행하면 마지막 delivery CAS 가 실패해도
   * 이미 발급된 PIN 을 되돌릴 수 없다. 따라서 한 트랜잭션에서 delivery claim(WAIT·양쪽 토큰 일치·미폐기)을
   * 새 ISO 토큰으로 갱신하고, command owner/generation/delivery_claim_token 도 함께 rotate 한다.
   * command CAS 가 실패하면 delivery 갱신도 롤백된다.
   */
  private async claimPinCommand(
    candidate: PinIssueCommandEntity,
    now: Date,
  ): Promise<{ authority: PinIssueCommandAuthority; deliveryClaimToken: string | null } | null> {
    const workflowVersion = candidate.workflowVersion;
    if (!candidate.ownerToken || !workflowVersion) return null;

    const ownerToken = randomUUID();
    const generation = String(BigInt(candidate.generation) + 1n);
    // 최초 권한 소비 전(STARTED·count=0) 명령은 STARTED 로 회수해야 이후 consumeInitialIssueAuthority(0→1)의
    // status=STARTED CAS 가 성립하고 hasConsumedSsgIssueAuthority(STARTED·1) 로 최초 INSERT 를 수행할 수 있다.
    // 그 외(RETRY_PENDING·RETRYING·count=1 STARTED)는 resolver 경유이므로 RETRYING 으로 회수한다.
    const reclaimToStarted = candidate.status === PinIssueCommandStatus.STARTED && candidate.externalIssueCount === 0;
    const reclaimedStatus = reclaimToStarted ? PinIssueCommandStatus.STARTED : PinIssueCommandStatus.RETRYING;

    const priorClaim = SsgRecoverySweepService.isoClaimDate(candidate.deliveryClaimToken);

    // 비-batch(ISO delivery claim 없음): command 만 회수. 이 명령들은 loop 에서 OPS 로 격리되거나
    // delivery claim 없이 resolver-only 로 처리되므로 mutation lease 갱신 대상이 아니다.
    if (!priorClaim) {
      const affected = await this.reclaimCommandOwnership(
        this.pinIssueCommandRepository.manager,
        candidate,
        now,
        ownerToken,
        generation,
        reclaimedStatus,
        candidate.deliveryClaimToken ?? null,
      );
      return affected === 1
        ? {
            authority: { commandId: candidate.id, ownerToken, generation, workflowVersion },
            deliveryClaimToken: candidate.deliveryClaimToken ?? null,
          }
        : null;
    }

    const newClaimToken = new Date(now.getTime()).toISOString();
    const newClaimDate = new Date(newClaimToken);
    try {
      return await this.pinIssueCommandRepository.manager.transaction(async (manager) => {
        const refreshed = await manager
          .createQueryBuilder()
          .update(OrderDeliveryEntity)
          .set({ claimedAt: newClaimDate, mutationClaimedAt: newClaimDate })
          .where('id = :id', { id: candidate.orderDeliveryId })
          .andWhere('status = :wait', { wait: IOrderDeliveryStatus.WAIT })
          .andWhere('claimed_at = :prior', { prior: priorClaim })
          .andWhere('mutation_claimed_at = :prior', { prior: priorClaim })
          .andWhere('destroyed_at IS NULL')
          .andWhere('discarded_at IS NULL')
          .andWhere('refunded_at IS NULL')
          .execute();
        // claim 이 탈취/상태변경/폐기됐다 → 외부 INSERT 를 하지 않고 회수도 하지 않는다(롤백).
        if (refreshed.affected !== 1) return null;

        const affected = await this.reclaimCommandOwnership(
          manager,
          candidate,
          now,
          ownerToken,
          generation,
          reclaimedStatus,
          newClaimToken,
        );
        if (affected !== 1) throw new PinIssueCommandClaimConflictError();
        return {
          authority: { commandId: candidate.id, ownerToken, generation, workflowVersion },
          deliveryClaimToken: newClaimToken,
        };
      });
    } catch (error) {
      if (error instanceof PinIssueCommandClaimConflictError) return null;
      throw error;
    }
  }

  /** 유효한 ISO delivery claim 토큰이면 Date, 아니면 null. batch 명령 판별에도 쓴다. */
  private static isoClaimDate(token: string | null | undefined): Date | null {
    if (!token) return null;
    const claimedAt = new Date(token);
    return !Number.isNaN(claimedAt.getTime()) && claimedAt.toISOString() === token ? claimedAt : null;
  }

  /** command owner/generation/lease/delivery_claim_token 을 fencing CAS 로 회수. affected 반환. */
  private async reclaimCommandOwnership(
    manager: EntityManager,
    candidate: PinIssueCommandEntity,
    now: Date,
    ownerToken: string,
    generation: string,
    status: PinIssueCommandStatus,
    deliveryClaimToken: string | null,
  ): Promise<number> {
    const result = await manager
      .createQueryBuilder()
      .update(PinIssueCommandEntity)
      .set({
        status,
        ownerToken,
        generation,
        deliveryClaimToken,
        leaseExpiresAt: new Date(now.getTime() + 5 * 60_000),
        stateEnteredAt: now,
        autoresolveVersion: () => 'COALESCE(autoresolve_version, 1)',
      })
      .where('id = :id', { id: candidate.id })
      .andWhere('owner_token = :previousOwnerToken', { previousOwnerToken: candidate.ownerToken })
      .andWhere('generation = :previousGeneration', { previousGeneration: candidate.generation })
      .andWhere('workflow_version = :workflowVersion', { workflowVersion: candidate.workflowVersion })
      .andWhere('delivery_claim_token <=> :priorClaimToken', { priorClaimToken: candidate.deliveryClaimToken ?? null })
      .andWhere(
        `(
          (status = :retryPending AND (next_attempt_at IS NULL OR next_attempt_at <= :now) AND (lease_expires_at IS NULL OR lease_expires_at < :now))
          OR (
            status = :retrying
            AND lease_expires_at < :now
          )
          OR (status = :started AND (lease_expires_at IS NULL OR lease_expires_at < :now))
        )`,
        {
          retryPending: PinIssueCommandStatus.RETRY_PENDING,
          retrying: PinIssueCommandStatus.RETRYING,
          started: PinIssueCommandStatus.STARTED,
          now,
        },
      )
      .execute();
    return result.affected ?? 0;
  }

  private async recordResolution(
    authority: PinIssueCommandAuthority,
    resolution: SsgPinResolution,
    status: PinIssueCommandStatus,
    nextAttemptAt: Date | null = null,
    resolutionDeadlineAt: Date | null = null,
    expectedLookupCount?: number,
  ): Promise<boolean> {
    return this.pinIssueCommandService.recordResolution(authority, {
      resolution,
      status,
      nextAttemptAt,
      resolutionDeadlineAt,
      expectedLookupCount,
    });
  }

  private async recordResolutionWithManager(
    manager: import('typeorm').EntityManager,
    authority: PinIssueCommandAuthority,
    resolution: SsgPinResolution,
    status: PinIssueCommandStatus,
  ): Promise<boolean> {
    const result = await manager
      .createQueryBuilder()
      .update(PinIssueCommandEntity)
      .set({
        resolution,
        status,
        nextAttemptAt: null,
        resolutionLookupCount: () => 'resolution_lookup_count + 1',
        resolutionStartedAt: () => 'COALESCE(resolution_started_at, CURRENT_TIMESTAMP(6))',
        stateEnteredAt: new Date(),
      })
      .where('id = :commandId', { commandId: authority.commandId })
      .andWhere('owner_token = :ownerToken', { ownerToken: authority.ownerToken })
      .andWhere('generation = :generation', { generation: authority.generation })
      .andWhere('workflow_version = :workflowVersion', { workflowVersion: authority.workflowVersion })
      .andWhere('status IN (:...allowedStatuses)', {
        allowedStatuses: PIN_ISSUE_AUTOMATED_TRANSITION_STATUSES,
      })
      .execute();
    return result.affected === 1;
  }

  private async restoreCommandAfterPreExternalFailure(
    manager: import('typeorm').EntityManager,
    authority: PinIssueCommandAuthority,
  ): Promise<boolean> {
    const result = await manager
      .createQueryBuilder()
      .update(PinIssueCommandEntity)
      .set({
        status: PinIssueCommandStatus.RETRY_PENDING,
        resolution: null,
        leaseExpiresAt: null,
        nextAttemptAt: new Date(Date.now() + 60_000),
        stateEnteredAt: new Date(),
      })
      .where('id = :commandId', { commandId: authority.commandId })
      .andWhere('owner_token = :ownerToken', { ownerToken: authority.ownerToken })
      .andWhere('generation = :generation', { generation: authority.generation })
      .andWhere('workflow_version = :workflowVersion', { workflowVersion: authority.workflowVersion })
      .execute();
    return result.affected === 1;
  }

  private async promoteOpsReview(authority: PinIssueCommandAuthority, resolution: SsgPinResolution): Promise<boolean> {
    const result = await this.pinIssueCommandRepository
      .createQueryBuilder()
      .update(PinIssueCommandEntity)
      .set({ status: PinIssueCommandStatus.OPS_REVIEW_REQUIRED, resolution, stateEnteredAt: new Date() })
      .where('id = :commandId', { commandId: authority.commandId })
      .andWhere('owner_token = :ownerToken', { ownerToken: authority.ownerToken })
      .andWhere('generation = :generation', { generation: authority.generation })
      .andWhere('workflow_version = :workflowVersion', { workflowVersion: authority.workflowVersion })
      .andWhere('status = :status', { status: PinIssueCommandStatus.RETRYING })
      .execute();
    return result.affected === 1;
  }

  /**
   * Completes the initial INSERT for a STARTED command that crashed before
   * consuming its sole authority (count=0). Consuming 0→1 first keeps the
   * pre-HTTP recheck honest; a failed issue leaves count=1 so a later pass
   * resolves by lookup instead of re-issuing.
   */
  private async executeInitialIssue(
    authority: PinIssueCommandAuthority,
    delivery: OrderDeliveryEntity,
    deliveryClaimToken: string | null,
  ): Promise<boolean> {
    if (!(await this.pinIssueCommandService.consumeInitialIssueAuthority(authority))) {
      return false;
    }
    try {
      const event = delivery.ssgEventId
        ? await this.ssgEventRepository.findOne({ where: { id: delivery.ssgEventId } })
        : null;
      await this.partnerCompanyExternService.issue(delivery, event, undefined, authority, 1);
      return this.completeConfirmedCommand(authority, delivery.id, deliveryClaimToken);
    } catch (error) {
      this.logger.error(
        `[PIN_RESOLUTION_SWEEP] command=${authority.commandId} initial issue failed: ${error instanceof Error ? error.message : error}`,
      );
      return false;
    }
  }

  /**
   * Performs the sole retry owned by a newly consumed NOT_ISSUED command.
   * Failure deliberately leaves RETRYING/NOT_ISSUED/count=2 intact; a later
   * expired-lease pass performs resolution only and never issues again.
   */
  private async executeNotIssuedRetry(
    authority: PinIssueCommandAuthority,
    delivery: OrderDeliveryEntity,
    deliveryClaimToken: string | null,
  ): Promise<boolean> {
    try {
      const event = delivery.ssgEventId
        ? await this.ssgEventRepository.findOne({ where: { id: delivery.ssgEventId } })
        : null;
      await this.partnerCompanyExternService.issue(delivery, event, undefined, authority, 2);
      return this.completeConfirmedCommand(authority, delivery.id, deliveryClaimToken);
    } catch (error) {
      this.logger.error(
        `[PIN_RESOLUTION_SWEEP] command=${authority.commandId} retry issue failed: ${error instanceof Error ? error.message : error}`,
      );
      return false;
    }
  }

  /**
   * The command service releases and terminalizes in one transaction so a
   * failed delivery CAS cannot make the command terminal.
   *
   * delivery claim 이 없으면(§6-B claim 해제 후 재진입) 재획득한 뒤 non-null 토큰으로
   * 종결한다. 재획득 실패 = 취소·환불·폐기 경합이므로 false 반환(다음 sweep 재시도).
   */
  private async completeConfirmedCommand(
    authority: PinIssueCommandAuthority,
    orderDeliveryId: number,
    deliveryClaimToken: string | null,
  ): Promise<boolean> {
    let effectiveToken = deliveryClaimToken;
    if (!effectiveToken) {
      const reacquired = await this.pinIssueCommandService.reacquireDeliveryClaim(
        authority,
        orderDeliveryId,
      );
      if (!reacquired) return false;
      effectiveToken = reacquired.deliveryClaimToken;
    }
    return this.pinIssueCommandService.markSucceededAfterDeliveryClaimRelease(
      authority,
      orderDeliveryId,
      effectiveToken,
    );
  }

  /**
   * classify→claim 재획득→PIN+종결+claim해제 원자적 완료.
   *
   * PIN 반영, command 종결, claim 해제를 한 트랜잭션으로 묶어 lease 만료 경합 시
   * PIN만 저장되는 문제를 방지한다. claim CAS 실패 시 PIN도 함께 롤백된다.
   */
  private async completeConfirmedCommandWithApply(
    authority: PinIssueCommandAuthority,
    delivery: OrderDeliveryEntity,
    deliveryClaimToken: string | null,
    confirmedCandidate: SsgIssueLogEntity | null,
    priorClaimToken?: string | null,
  ): Promise<boolean> {
    let effectiveToken = deliveryClaimToken;
    if (!effectiveToken) {
      const reacquired = priorClaimToken != null
        ? await this.pinIssueCommandService.reacquireDeliveryClaim(authority, delivery.id, priorClaimToken)
        : await this.pinIssueCommandService.reacquireDeliveryClaim(authority, delivery.id);
      if (!reacquired) return false;
      effectiveToken = reacquired.deliveryClaimToken;
    }
    if (confirmedCandidate) {
      return this.pinIssueCommandService.markSucceededWithPinAfterDeliveryClaimRelease(
        authority,
        delivery.id,
        effectiveToken,
        {
          barCode: confirmedCandidate.barCode,
          personalCode: confirmedCandidate.personalCode,
          ssgTransactionId: confirmedCandidate.ssgTransactionId,
          couponNum: confirmedCandidate.couponNum,
          expireAt: confirmedCandidate.expireAt,
          encourageAt: confirmedCandidate.encourageAt,
          ssgEventId: confirmedCandidate.ssgEventId,
        },
      );
    }
    return this.pinIssueCommandService.markSucceededAfterDeliveryClaimRelease(
      authority,
      delivery.id,
      effectiveToken,
    );
  }

  /**
   * §7-3 마감 산출. delivery 의 상품 정보 + ssg_issue_log 후보 데이터로 deadline 을 계산한다.
   * command 에 이미 저장돼 있으면 그 값이 우선(COALESCE). 산출 불가 시 null.
   */
  private async computeDeadlineForCommand(
    candidate: PinIssueCommandEntity,
    delivery: OrderDeliveryEntity,
  ): Promise<Date | null> {
    if (candidate.resolutionDeadlineAt) return candidate.resolutionDeadlineAt;
    const mapping = delivery.orderProductMapping;
    const product = mapping?.product;

    let candidateExpireAt: Date | null = null;
    let candidateInsertedAt: Date | null = null;
    const row = await this.ssgIssueLogRepository
      .createQueryBuilder('l')
      .select('MAX(l.expire_at)', 'maxExpireAt')
      .addSelect('MAX(l.inserted_at)', 'maxInsertedAt')
      .where('l.order_delivery_id = :odId', { odId: delivery.id })
      .andWhere('l.superseded_at IS NULL')
      .getRawOne();
    if (row?.maxExpireAt) candidateExpireAt = new Date(row.maxExpireAt);
    if (row?.maxInsertedAt) candidateInsertedAt = new Date(row.maxInsertedAt);

    return computeResolutionDeadline({
      candidateExpireAt,
      candidateInsertedAt,
      commandCreatedAt: candidate.createdAt,
      snapshotProductExpireDay: mapping?.snapshotProductExpireDay,
      productExpireDay: product?.expireDay,
    });
  }

  /**
   * §7-3 deadline 을 외부 호출 전에 durable 저장. COALESCE CAS — 이미 저장됐으면 무시.
   * 장애 시 변경된 상품/로그로 재계산되는 것을 방지한다.
   *
   * fail-closed: 저장 실패(DB 예외 또는 CAS 미적중) 시 false 반환. 호출자는 외부 호출을 중단해야 한다.
   */
  private async persistDeadline(authority: PinIssueCommandAuthority, deadline: Date): Promise<boolean> {
    try {
      const result = await this.pinIssueCommandRepository
        .createQueryBuilder()
        .update(PinIssueCommandEntity)
        .set({
          resolutionDeadlineAt: () => 'COALESCE(resolution_deadline_at, :deadlineParam)',
        })
        .setParameter('deadlineParam', deadline)
        .where('id = :commandId', { commandId: authority.commandId })
        .andWhere('owner_token = :ownerToken', { ownerToken: authority.ownerToken })
        .andWhere('generation = :generation', { generation: authority.generation })
        .andWhere('workflow_version = :workflowVersion', { workflowVersion: authority.workflowVersion })
        .execute();
      return (result.affected ?? 0) >= 1;
    } catch (error) {
      this.logger.error(
        `[PIN_RESOLUTION_SWEEP] deadline persist failed command=${authority.commandId}: ${error instanceof Error ? error.message : error}`,
      );
      return false;
    }
  }

  /**
   * §7-3 마감 도달 시 OPS_REVIEW_REQUIRED + claim 해제.
   * delivery claim 을 풀어야 CS·폐기가 진행되므로, 마감 승격 시에도 claim 을 해제한다.
   */
  private async promoteOpsReviewWithClaimRelease(
    authority: PinIssueCommandAuthority,
    resolution: SsgPinResolution,
    orderDeliveryId: number,
    deliveryClaimToken: string | null,
    reason: string,
  ): Promise<boolean> {
    this.logger.warn(
      `[PIN_RESOLUTION_SWEEP] command=${authority.commandId} deadline exceeded (${reason}), promoting to OPS_REVIEW_REQUIRED`,
    );
    const claimedAt = deliveryClaimToken ? new Date(deliveryClaimToken) : null;
    const validClaim =
      claimedAt && !Number.isNaN(claimedAt.getTime()) && claimedAt.toISOString() === deliveryClaimToken;

    try {
      return await this.pinIssueCommandRepository.manager.transaction(async (manager) => {
        if (validClaim) {
          const released = await manager
            .createQueryBuilder()
            .update(OrderDeliveryEntity)
            .set({ claimedAt: null, mutationClaimedAt: null })
            .where('id = :id', { id: orderDeliveryId })
            .andWhere('claimed_at = :claimedAt', { claimedAt })
            .andWhere('mutation_claimed_at = :claimedAt', { claimedAt })
            .execute();
          if (released.affected !== 1) return false;
        }

        const result = await manager
          .createQueryBuilder()
          .update(PinIssueCommandEntity)
          .set({
            status: PinIssueCommandStatus.OPS_REVIEW_REQUIRED,
            resolution,
            deliveryClaimToken: null,
            leaseExpiresAt: null,
            stateEnteredAt: new Date(),
          })
          .where('id = :commandId', { commandId: authority.commandId })
          .andWhere('owner_token = :ownerToken', { ownerToken: authority.ownerToken })
          .andWhere('generation = :generation', { generation: authority.generation })
          .andWhere('workflow_version = :workflowVersion', { workflowVersion: authority.workflowVersion })
          .andWhere('status IN (:...allowedStatuses)', {
            allowedStatuses: PIN_ISSUE_AUTOMATED_TRANSITION_STATUSES,
          })
          .execute();
        if (result.affected !== 1) throw new PinIssueCommandClaimConflictError();
        return true;
      });
    } catch {
      return false;
    }
  }

  /**
   * delivery claim 없이 command 만 회수 후 OPS 승격. claim 실패 복구의 터미널 분기.
   * 회수와 승격을 한 트랜잭션으로 묶어, 중간 장애 시 RETRYING 고아를 방지한다.
   */
  private async reclaimAndPromoteOps(
    candidate: PinIssueCommandEntity,
    attemptAt: Date,
    resolution: SsgPinResolution,
    reason: string,
  ): Promise<'ops_review' | null> {
    const ownerToken = randomUUID();
    const generation = String(BigInt(candidate.generation) + 1n);
    const workflowVersion = candidate.workflowVersion!;

    this.logger.warn(
      `[PIN_RESOLUTION_SWEEP] claim failure recovery command=${candidate.id} reason=${reason}, promoting to OPS_REVIEW_REQUIRED`,
    );

    try {
      return await this.pinIssueCommandRepository.manager.transaction(async (manager) => {
        const affected = await this.reclaimCommandOwnership(
          manager,
          candidate,
          attemptAt,
          ownerToken,
          generation,
          PinIssueCommandStatus.RETRYING,
          null,
        );
        if (affected !== 1) return null;

        const result = await manager
          .createQueryBuilder()
          .update(PinIssueCommandEntity)
          .set({ status: PinIssueCommandStatus.OPS_REVIEW_REQUIRED, resolution, stateEnteredAt: new Date(), leaseExpiresAt: null })
          .where('id = :commandId', { commandId: candidate.id })
          .andWhere('owner_token = :ownerToken', { ownerToken })
          .andWhere('generation = :generation', { generation })
          .andWhere('workflow_version = :workflowVersion', { workflowVersion })
          .andWhere('status = :status', { status: PinIssueCommandStatus.RETRYING })
          .execute();
        if (result.affected !== 1) return null;
        return 'ops_review' as const;
      });
    } catch {
      return null;
    }
  }

  /**
   * claim 실패 복구에서 non-NOT_ATTEMPTED resolution 을 정상 흐름으로 합류시킨다.
   *
   * - CONFIRMED → command 회수 후 completeConfirmedCommandWithApply (delivery claim 재획득 포함)
   * - PROCESSING/LOOKUP_FAILED → command 회수 후 RETRY_PENDING + 백오프
   * - 기타 (UNKNOWN, MULTIPLE_CONFIRMED 등) → command 회수 후 OPS
   */
  private async recoverClaimFailureByResolution(
    candidate: PinIssueCommandEntity,
    attemptAt: Date,
    delivery: OrderDeliveryEntity,
    classification: SsgDeferredClassification,
    deadline: Date | null,
  ): Promise<'confirmed' | 'ops_review' | null> {
    const { resolution, confirmedCandidate } = classification;

    if (resolution === SsgPinResolution.CONFIRMED) {
      const ownerToken = randomUUID();
      const generation = String(BigInt(candidate.generation) + 1n);
      const workflowVersion = candidate.workflowVersion!;

      const affected = await this.reclaimCommandOwnership(
        this.pinIssueCommandRepository.manager,
        candidate,
        attemptAt,
        ownerToken,
        generation,
        PinIssueCommandStatus.RETRYING,
        candidate.deliveryClaimToken,
      );
      if (affected !== 1) return null;

      const authority: PinIssueCommandAuthority = { commandId: candidate.id, ownerToken, generation, workflowVersion };

      if (deadline && !candidate.resolutionDeadlineAt) {
        if (!(await this.persistDeadline(authority, deadline))) {
          try {
            const restored = await this.restoreCommandAfterPreExternalFailure(
              this.pinIssueCommandRepository.manager,
              authority,
            );
            if (!restored) {
              this.logger.error(
                `[PIN_RESOLUTION_SWEEP] CONFIRMED deadline persist + command restore both failed command=${candidate.id}`,
              );
            }
          } catch (cleanupError) {
            this.logger.error(
              `[PIN_RESOLUTION_SWEEP] CONFIRMED deadline persist cleanup failed command=${candidate.id}: ${cleanupError instanceof Error ? cleanupError.message : cleanupError}`,
            );
          }
          return null;
        }
      }

      this.logger.log(
        `[PIN_RESOLUTION_SWEEP] claim failure CONFIRMED recovery command=${candidate.id}, attempting completeConfirmedCommandWithApply`,
      );
      if (await this.completeConfirmedCommandWithApply(authority, delivery, null, confirmedCandidate ?? null, candidate.deliveryClaimToken)) {
        return 'confirmed';
      }
      if (await this.promoteOpsReview(authority, resolution)) {
        return 'ops_review';
      }
      return null;
    }

    if (
      resolution === SsgPinResolution.PROCESSING ||
      resolution === SsgPinResolution.LOOKUP_FAILED
    ) {
      const ownerToken = randomUUID();
      const generation = String(BigInt(candidate.generation) + 1n);
      const workflowVersion = candidate.workflowVersion!;

      const affected = await this.reclaimCommandOwnership(
        this.pinIssueCommandRepository.manager,
        candidate,
        attemptAt,
        ownerToken,
        generation,
        PinIssueCommandStatus.RETRYING,
        null,
      );
      if (affected !== 1) return null;

      const authority: PinIssueCommandAuthority = { commandId: candidate.id, ownerToken, generation, workflowVersion };
      const backoffMs = computeResolutionBackoffMs(candidate.resolutionStartedAt, attemptAt);
      const nextAttemptAt = new Date(attemptAt.getTime() + backoffMs);
      this.logger.log(
        `[PIN_RESOLUTION_SWEEP] claim failure ${resolution} recovery command=${candidate.id}, setting RETRY_PENDING`,
      );
      if (await this.recordResolution(authority, resolution, PinIssueCommandStatus.RETRY_PENDING, nextAttemptAt, deadline, candidate.resolutionLookupCount)) {
        return null;
      }
      return null;
    }

    if (resolution === SsgPinResolution.NOT_ISSUED) {
      const ownerToken = randomUUID();
      const generation = String(BigInt(candidate.generation) + 1n);
      const workflowVersion = candidate.workflowVersion!;

      const affected = await this.reclaimCommandOwnership(
        this.pinIssueCommandRepository.manager,
        candidate,
        attemptAt,
        ownerToken,
        generation,
        PinIssueCommandStatus.RETRYING,
        null,
      );
      if (affected !== 1) return null;

      const authority: PinIssueCommandAuthority = { commandId: candidate.id, ownerToken, generation, workflowVersion };
      const backoffMs = computeResolutionBackoffMs(candidate.resolutionStartedAt, attemptAt);
      const nextAttemptAt = new Date(attemptAt.getTime() + backoffMs);
      this.logger.log(
        `[PIN_RESOLUTION_SWEEP] claim failure NOT_ISSUED recovery command=${candidate.id}, setting RETRY_PENDING with streak+1`,
      );
      await this.recordResolution(authority, resolution, PinIssueCommandStatus.RETRY_PENDING, nextAttemptAt, deadline, candidate.resolutionLookupCount);
      return null;
    }

    return this.reclaimAndPromoteOps(
      candidate,
      attemptAt,
      resolution,
      'CLAIM_FAILURE_NON_NOT_ATTEMPTED',
    );
  }

  /**
   * EP-P30 §7-1 claim 실패 복구.
   *
   * `claimPinCommand` 가 실패한 후보를 처리한다. delivery claim CAS 실패가 주 원인이며,
   * 이 경우 delivery 는 이미 다른 actor 에게 탈취/상태변경됐다.
   *
   * 분기:
   *   - NOT_ATTEMPTED + gate 열림 + deadline 유효 → 발급 복구
   *   - deadline 만료/산출불가 → command 회수 + OPS 승격
   *   - CONFIRMED → command 회수 + 정상 확인 흐름 합류
   *   - PROCESSING/LOOKUP_FAILED → command 회수 + RETRY_PENDING + 백오프
   *   - 기타 → command 회수 + OPS 승격
   *
   * 비-batch 명령이거나 ownerToken/workflowVersion 없으면 null(기존 skip).
   */
  private async tryRecoverFromClaimFailure(
    candidate: PinIssueCommandEntity,
    attemptAt: Date,
  ): Promise<'confirmed' | 'ops_review' | null> {
    const priorClaim = SsgRecoverySweepService.isoClaimDate(candidate.deliveryClaimToken);
    if (!priorClaim) return null;
    if (!candidate.ownerToken || !candidate.workflowVersion) return null;
    if (candidate.externalIssueCount < 1) return null;

    // ── Phase 1: 순수 판정 (durable 변경 0) ──
    const capability = this.autoResolveConfig.capabilityFor(candidate);
    if (!capability.commandTransition) return null;

    const delivery = await this.orderDeliveryRepository.findOne({
      where: { id: candidate.orderDeliveryId },
      relations: { orderProductMapping: { product: { partnerCompany: true } } },
    });
    if (!delivery) return null;

    // §7-3 deadline 검사
    const deadline = await this.computeDeadlineForCommand(candidate, delivery);
    const effectiveDeadline = candidate.resolutionDeadlineAt ?? deadline;
    const deadlineExpired = effectiveDeadline && attemptAt >= effectiveDeadline;
    const deadlineUncomputable = !deadline && !candidate.resolutionDeadlineAt;

    // deadline 만료/산출불가 → command 만 회수 후 OPS 승격 (delivery claim 없이)
    if (deadlineExpired || deadlineUncomputable) {
      return this.reclaimAndPromoteOps(
        candidate,
        attemptAt,
        candidate.resolution ?? SsgPinResolution.UNKNOWN,
        deadlineExpired ? 'DEADLINE_EXCEEDED' : 'DEADLINE_UNCOMPUTABLE',
      );
    }

    const classification = await this.partnerCompanyExternService.classifyDeferredSsgIssue(delivery.id);

    // §7-3 외부 조회 완료 후 deadline 재검사 — 조회 도중 만료를 감지한다.
    const postLookupAt = new Date();
    if (effectiveDeadline && postLookupAt >= effectiveDeadline) {
      return this.reclaimAndPromoteOps(
        candidate,
        attemptAt,
        classification.resolution,
        'DEADLINE_EXCEEDED_DURING_CLAIM_FAILURE_LOOKUP',
      );
    }

    // NOT_ATTEMPTED 외 상태 → resolution 별 정상 흐름 합류.
    if (classification.resolution !== SsgPinResolution.NOT_ATTEMPTED) {
      return this.recoverClaimFailureByResolution(
        candidate,
        attemptAt,
        delivery,
        classification,
        deadline,
      );
    }

    // NOT_ATTEMPTED + gate 확인. gate 불가(off-drain: insertOrdinal1=false) 시 OPS 종결.
    const gate = canExecuteOrdinal(capability, 1);
    if (!gate.allowed) {
      return this.reclaimAndPromoteOps(
        candidate,
        attemptAt,
        SsgPinResolution.NOT_ATTEMPTED,
        'CLAIM_FAILURE_NOT_ATTEMPTED_GATE_CLOSED',
      );
    }

    // ── Phase 2: durable 변경 (판정 통과 후에만) ──
    const ownerToken = randomUUID();
    const generation = String(BigInt(candidate.generation) + 1n);
    const workflowVersion = candidate.workflowVersion;

    const authority: PinIssueCommandAuthority = { commandId: candidate.id, ownerToken, generation, workflowVersion };
    const lease = new Date(attemptAt.getTime() + 5 * 60_000);

    let claimResult: { deliveryClaimToken: string } | null;
    try {
      claimResult = await this.pinIssueCommandRepository.manager.transaction(async (manager) => {
        const commandClaimed = await this.reclaimCommandOwnership(
          manager,
          candidate,
          attemptAt,
          ownerToken,
          generation,
          candidate.status,
          null,
        );
        if (commandClaimed !== 1) return null;

        if (!(await this.pinIssueCommandService.reclaimNotAttemptedAuthority(authority, delivery.id, lease, manager))) {
          throw new PinIssueCommandClaimConflictError();
        }

        const deliveryClaim = await this.pinIssueCommandService.reacquireDeliveryClaim(authority, delivery.id, candidate.deliveryClaimToken, manager);
        if (!deliveryClaim) throw new PinIssueCommandClaimConflictError();
        return deliveryClaim;
      });
    } catch (error) {
      if (error instanceof PinIssueCommandClaimConflictError) return null;
      throw error;
    }
    if (!claimResult) return null;

    if (deadline && !candidate.resolutionDeadlineAt) {
      if (!(await this.persistDeadline(authority, deadline))) {
        try {
          await this.pinIssueCommandRepository.manager.transaction(async (manager) => {
            const claimDate = new Date(claimResult!.deliveryClaimToken);
            const released = await manager
              .createQueryBuilder()
              .update(OrderDeliveryEntity)
              .set({ claimedAt: null, mutationClaimedAt: null })
              .where('id = :id', { id: delivery.id })
              .andWhere('claimed_at = :ct', { ct: claimDate })
              .andWhere('mutation_claimed_at = :mt', { mt: claimDate })
              .execute();
            if (released.affected !== 1) throw new Error('claim release CAS failed');
            const restored = await this.restoreCommandAfterPreExternalFailure(manager, authority);
            if (!restored) throw new Error('command restore CAS failed');
          });
        } catch (cleanupError) {
          this.logger.error(
            `[PIN_RESOLUTION_SWEEP] deadline persist cleanup failed command=${candidate.id}: ${cleanupError instanceof Error ? cleanupError.message : cleanupError}`,
          );
        }
        return null;
      }
    }

    try {
      const event = delivery.ssgEventId
        ? await this.ssgEventRepository.findOne({ where: { id: delivery.ssgEventId } })
        : null;
      await this.partnerCompanyExternService.issue(delivery, event, undefined, authority, 1);

      if (
        await this.pinIssueCommandService.markSucceededAfterDeliveryClaimRelease(
          authority,
          delivery.id,
          claimResult.deliveryClaimToken,
        )
      ) {
        return 'confirmed';
      }
      return null;
    } catch (error) {
      this.logger.error(
        `[PIN_RESOLUTION_SWEEP] NOT_ATTEMPTED recovery failed command=${candidate.id}: ${error instanceof Error ? error.message : error}`,
      );

      let hasOrdinalLog: number;
      try {
        hasOrdinalLog = await this.ssgIssueLogRepository.count({
          where: { pinIssueCommandId: String(candidate.id), issueOrdinal: 1 },
        });
      } catch (logQueryError) {
        this.logger.error(
          `[PIN_RESOLUTION_SWEEP] ordinal log query failed command=${candidate.id}, falling back to OPS_REVIEW: ${logQueryError instanceof Error ? logQueryError.message : logQueryError}`,
        );
        hasOrdinalLog = 1;
      }

      try {
        await this.pinIssueCommandRepository.manager.transaction(async (manager) => {
          const claimDate = new Date(claimResult!.deliveryClaimToken);
          const released = await manager
            .createQueryBuilder()
            .update(OrderDeliveryEntity)
            .set({ claimedAt: null, mutationClaimedAt: null })
            .where('id = :id', { id: delivery.id })
            .andWhere('claimed_at = :ct', { ct: claimDate })
            .andWhere('mutation_claimed_at = :mt', { mt: claimDate })
            .execute();
          if (released.affected !== 1) {
            throw new Error(`delivery claim release fencing failed: affected=${released.affected}`);
          }
          if (hasOrdinalLog > 0) {
            const recorded = await this.recordResolutionWithManager(manager, authority, SsgPinResolution.UNKNOWN, PinIssueCommandStatus.OPS_REVIEW_REQUIRED);
            if (!recorded) {
              throw new Error('command OPS_REVIEW_REQUIRED CAS failed during cleanup');
            }
          } else {
            const restored = await this.restoreCommandAfterPreExternalFailure(manager, authority);
            if (!restored) {
              throw new Error('command restore after pre-external failure CAS failed');
            }
          }
        });
      } catch (cleanupError) {
        this.logger.error(
          `[PIN_RESOLUTION_SWEEP] claim release on failure also failed command=${candidate.id}: ${cleanupError instanceof Error ? cleanupError.message : cleanupError}`,
        );
        return null;
      }
      return hasOrdinalLog > 0 ? 'ops_review' : null;
    }
  }
}

/** delivery claim 갱신 후 command CAS 가 실패하면 트랜잭션을 롤백하기 위한 내부 신호. */
class PinIssueCommandClaimConflictError extends Error {}
