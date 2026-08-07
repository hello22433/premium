import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { PartnerCompanyEntity } from '../../entity/partner.company.entity';
import { PartnerSettleBatchEntity } from '../../entity/partner.settle.batch.entity';
import { PartnerSettleLedgerEntity } from '../../entity/partner.settle.ledger.entity';
import { PartnerSettlePaymentRequestEntity } from '../../entity/partner.settle.payment.request.entity';
import { PartnerSettlePaymentVarianceProposalEntity } from '../../entity/partner.settle.payment.variance.proposal.entity';
import { ActivityLogService } from '../../activity_log/application/activity.log.service';
import { ActivityLogActionType } from '../../activity_log/interface/activity.log.action.type';
import { ActivityLogResult } from '../../activity_log/interface/activity.log.result';
import { parseKstDateTime, toDbDateTimeString, KstInstant } from '../domain/settle.time';
import { PartnerSettleFeatureFlag } from './partner.settle.feature.flag';
import { PartnerSettleLedgerService } from './partner.settle.ledger.service';
import { VarianceDecisionReqDto, VarianceQueryDto } from '../api/dto/payment.variance.dto';

const MAX_RETRY = 3;
const RETRY_JITTERS_MS = [50, 100]; // full jitter ceilings for 1st, 2nd retry

/** 결정자 식별 + 감사 기록에 필요한 최소 정보. 컨트롤러가 채운다. */
export type VarianceActor = {
  id: number;
  email: string;
  ipAddress: string;
};

/**
 * 지급 차이(`PAYMENT_VARIANCE`) 승인·반려 (정본 §5.7.2 · §5 318행 · PR3A).
 *
 * PR1D 의 paid 경로가 `actualPaidAmount != calculatedPaidAmount` 일 때 만든 PENDING proposal 을
 * **기안자와 다른 사람**이 종결한다. 승인은 차이만큼의 ADJUSTMENT 원장을 한 건 남기고 batch 를 PAID 로,
 * 반려는 batch 를 `CONFIRMED_UNPAID` 로 되돌린다(원장 미생성).
 *
 * 설계상 지켜야 할 규칙 셋:
 * 1. **`T_decision` 은 DB 에서 한 번만 읽는다.** proposal.approvedAt · ledger.occurredAt · 감사 시각이
 *    같은 값이어야 "승인 시점 이후 최초 sweep 에 정확히 한 번 편입" 이 성립한다. `new Date()` 로 각각
 *    찍으면 세 값이 마이크로초 단위로 갈라져 귀속 판정과 증적이 어긋난다.
 * 2. **잠금 순서는 paid 와 동일**(anchor → batch → payment request → proposal → ledger)하다.
 *    순서를 바꾸면 같은 batch 를 노리는 paid 요청과 교차 데드락에 걸린다.
 * 3. **계산액을 승인 시점에 재검증한다.** 확정 후 원장이 움직였는데 옛 계산액으로 승인하면 차이 금액이
 *    틀린 채로 회계에 박힌다. 불일치는 409 이고 proposal 은 PENDING 으로 남는다(반려 후 재기안).
 */
@Injectable()
export class PartnerSettlePaymentVarianceService {
  private readonly logger = new Logger(PartnerSettlePaymentVarianceService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly featureFlag: PartnerSettleFeatureFlag,
    private readonly ledgerService: PartnerSettleLedgerService,
    private readonly activityLogService: ActivityLogService,
  ) {}

  /** GET settle/partner-company/payment-variance-proposals */
  async findProposals(query: VarianceQueryDto): Promise<Record<string, unknown>[]> {
    this.assertEnabled();

    const qb = this.dataSource
      .getRepository(PartnerSettlePaymentVarianceProposalEntity)
      .createQueryBuilder('p')
      .orderBy('p.id', 'DESC')
      .take(query.limit ?? 50)
      .skip(query.offset ?? 0);

    if (query.status) qb.andWhere('p.status = :status', { status: query.status });
    if (query.partnerCompanyId) qb.andWhere('p.partnerCompanyId = :pcId', { pcId: query.partnerCompanyId });
    if (query.batchId) qb.andWhere('p.batchId = :bid', { bid: query.batchId });

    const proposals = await qb.getMany();
    return Promise.all(proposals.map((proposal) => this.toView(proposal)));
  }

  /** GET settle/partner-company/payment-variance-proposals/:id */
  async findProposal(id: number): Promise<Record<string, unknown>> {
    this.assertEnabled();

    const proposal = await this.dataSource
      .getRepository(PartnerSettlePaymentVarianceProposalEntity)
      .findOne({ where: { id } });
    if (!proposal) throw new NotFoundException(`지급 차이 proposal ${id}을 찾을 수 없습니다.`);

    return this.toView(proposal);
  }

  /** POST settle/partner-company/payment-variance-proposals/:id/approve */
  async approve(id: number, dto: VarianceDecisionReqDto, actor: VarianceActor): Promise<Record<string, unknown>> {
    return this.withRetry(() => this.approveTransaction(id, this.normalizeReason(dto), actor));
  }

  /** POST settle/partner-company/payment-variance-proposals/:id/reject */
  async reject(id: number, dto: VarianceDecisionReqDto, actor: VarianceActor): Promise<Record<string, unknown>> {
    return this.withRetry(() => this.rejectTransaction(id, this.normalizeReason(dto), actor));
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 승인
  // ──────────────────────────────────────────────────────────────────────────

  private async approveTransaction(
    id: number,
    decisionReason: string,
    actor: VarianceActor,
  ): Promise<Record<string, unknown>> {
    this.assertEnabled();

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const manager = queryRunner.manager;

      const { proposal, batch, request } = await this.lockDecisionScope(manager, id);

      // 이미 종결된 proposal — 같은 결정 재시도는 기존 결과, 상반 결정은 409.
      if (proposal.status === 'APPROVED') {
        const result = await this.approvedResult(manager, proposal);
        await queryRunner.commitTransaction();
        return result;
      }
      if (proposal.status === 'REJECTED') {
        throw new ConflictException(`지급 차이 proposal ${id}은 이미 반려되었습니다.`);
      }

      this.assertNotSelfDecision(proposal, actor);

      if (request.status !== 'PENDING_VARIANCE') {
        throw new ConflictException(`지급 요청 ${request.id}은 ${request.status} 상태라 승인할 수 없습니다.`);
      }
      if (batch.status !== 'CONFIRMED_UNPAID') {
        throw new ConflictException(`batch ${batch.id}은 ${batch.status} 상태라 승인할 수 없습니다.`);
      }

      // 계산액 재검증 — 확정 후 원장이 움직였으면 옛 차이 금액은 이미 틀렸다.
      const recomputed = await this.recomputePayable(manager, batch);
      if (recomputed.calculatedPaidAmount !== BigInt(proposal.calculatedPaidAmount)) {
        throw new ConflictException(
          `VARIANCE_STALE: 지급예정액이 ${proposal.calculatedPaidAmount} → ${recomputed.calculatedPaidAmount} 로 변경되었습니다. ` +
            '기존 proposal 을 반려한 뒤 새 paidRequestKey 로 재요청하세요.',
        );
      }

      const varianceAmount = BigInt(proposal.actualPaidAmount) - recomputed.calculatedPaidAmount;
      if (varianceAmount === 0n) {
        // 차이가 없으면 애초에 proposal 이 생기지 않는다. 여기 오면 재계산 경로가 깨진 것이다.
        throw new ConflictException('지급 차이가 0 입니다. proposal 상태가 계산 결과와 어긋납니다.');
      }

      // T_decision — proposal.approvedAt · ledger.occurredAt · 감사 시각 공통 기준.
      const decisionAt = await this.readDbNow(manager);
      const decisionAtDb = toDbDateTimeString(decisionAt);

      // 원장은 proposal UPDATE 보다 먼저 — result 복합 FK 가 그 순서만 허용한다.
      const ledger = await this.ledgerService.appendVarianceAdjustment(
        {
          partnerCompanyId: proposal.partnerCompanyId,
          paymentVarianceProposalId: proposal.id,
          // 과지급(actual > calculated)이면 음수 = 다음 sweep 지급액 차감.
          settleAmount: -varianceAmount,
          occurredAt: decisionAt,
          memo: proposal.memo,
        },
        manager,
      );

      // datetime(6) 은 canonical 문자열로 저장한다. Date 로 넘기면 마이크로초가 잘려 세 값이 갈라진다.
      await manager.query(
        `UPDATE partner_settle_payment_variance_proposal
            SET status = 'APPROVED', approved_by = ?, approved_at = ?, decision_reason = ?, result_ledger_id = ?
          WHERE id = ? AND status = 'PENDING'`,
        [actor.id, decisionAtDb, decisionReason, ledger.id, proposal.id],
      );

      await manager.getRepository(PartnerSettlePaymentRequestEntity).update(request.id, { status: 'PAID' });

      await manager.query(
        `UPDATE partner_settle_batch
            SET status = 'PAID', paid_at = ?, paid_by = ?, payment_evidence_ref = ?,
                payment_request_id = ?, paid_request_key = ?, paid_payload_hash = ?, paid_payload_hash_version = ?,
                carry_in_amount = ?, finalized_total_amount = ?, carry_out_amount = ?,
                paid_amount = ?, calculated_paid_amount = ?, actual_paid_amount = ?
          WHERE id = ?`,
        [
          decisionAtDb,
          // 지급 기안자(=paid 요청자)를 남긴다. 승인자는 proposal.approvedBy 로 분리 보존된다.
          proposal.proposedBy,
          proposal.paymentEvidenceRef,
          request.id,
          request.paidRequestKey,
          request.payloadHash,
          request.payloadHashVersion,
          recomputed.carryInAmount.toString(),
          recomputed.finalizedTotalAmount.toString(),
          recomputed.carryOutAmount.toString(),
          // paid_amount = 실제 나간 현금이다(DB CHECK `paid_amount = actual_paid_amount`).
          // 계산액과의 차이는 이 batch 를 고치지 않고 다음 sweep ADJUSTMENT 로 흡수된다.
          proposal.actualPaidAmount,
          recomputed.calculatedPaidAmount.toString(),
          proposal.actualPaidAmount,
          batch.id,
        ],
      );

      await this.writeAuditLog(manager, ActivityLogActionType.PARTNER_SETTLE_VARIANCE_APPROVE, actor, decisionAtDb, {
        proposalId: proposal.id,
        batchId: batch.id,
        partnerCompanyId: proposal.partnerCompanyId,
        calculatedPaidAmount: proposal.calculatedPaidAmount,
        actualPaidAmount: proposal.actualPaidAmount,
        varianceAmount: varianceAmount.toString(),
        resultLedgerId: ledger.id,
        decidedAt: decisionAtDb,
        decisionReason,
      });

      await queryRunner.commitTransaction();

      this.logger.log(
        `지급 차이 승인: proposal=${proposal.id} batch=${batch.id} variance=${varianceAmount} ledger=${ledger.id}`,
      );

      return {
        proposalId: proposal.id,
        status: 'APPROVED',
        resultLedgerId: ledger.id,
        varianceAmount: varianceAmount.toString(),
        adjustmentAmount: (-varianceAmount).toString(),
        approvedAt: decisionAtDb,
      };
    } catch (e) {
      await queryRunner.rollbackTransaction();
      throw e;
    } finally {
      await queryRunner.release();
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 반려
  // ──────────────────────────────────────────────────────────────────────────

  private async rejectTransaction(
    id: number,
    decisionReason: string,
    actor: VarianceActor,
  ): Promise<Record<string, unknown>> {
    this.assertEnabled();

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const manager = queryRunner.manager;

      const { proposal, batch, request } = await this.lockDecisionScope(manager, id);

      if (proposal.status === 'REJECTED') {
        await queryRunner.commitTransaction();
        return {
          proposalId: proposal.id,
          status: 'REJECTED',
          rejectedAt: proposal.rejectedAt === null ? null : this.formatDbDate(proposal.rejectedAt),
        };
      }
      if (proposal.status === 'APPROVED') {
        throw new ConflictException(`지급 차이 proposal ${id}은 이미 승인되었습니다.`);
      }

      this.assertNotSelfDecision(proposal, actor);

      // 반려도 승인과 같은 상태 재검증을 거친다. proposal 만 보고 종결하면 이미 PAID 된 request 를
      // REJECTED 로 덮어써 지급 사실과 요청 상태가 어긋난다.
      if (request.status !== 'PENDING_VARIANCE') {
        throw new ConflictException(`지급 요청 ${request.id}은 ${request.status} 상태라 반려할 수 없습니다.`);
      }
      if (batch.status !== 'CONFIRMED_UNPAID') {
        throw new ConflictException(`batch ${batch.id}은 ${batch.status} 상태라 반려할 수 없습니다.`);
      }

      const decisionAt = await this.readDbNow(manager);
      const decisionAtDb = toDbDateTimeString(decisionAt);

      await manager.query(
        `UPDATE partner_settle_payment_variance_proposal
            SET status = 'REJECTED', rejected_by = ?, rejected_at = ?, decision_reason = ?
          WHERE id = ? AND status = 'PENDING'`,
        [actor.id, decisionAtDb, decisionReason, proposal.id],
      );

      // request 를 함께 종결해야 같은 batch 에 새 paid 요청을 넣을 수 있다(PENDING_VARIANCE UNIQUE).
      await manager.getRepository(PartnerSettlePaymentRequestEntity).update(request.id, { status: 'REJECTED' });

      // batch 는 건드리지 않는다 — CONFIRMED_UNPAID 로 남아 재기안 대상이 된다.

      await this.writeAuditLog(manager, ActivityLogActionType.PARTNER_SETTLE_VARIANCE_REJECT, actor, decisionAtDb, {
        proposalId: proposal.id,
        batchId: batch.id,
        partnerCompanyId: proposal.partnerCompanyId,
        calculatedPaidAmount: proposal.calculatedPaidAmount,
        actualPaidAmount: proposal.actualPaidAmount,
        decidedAt: decisionAtDb,
        decisionReason,
      });

      await queryRunner.commitTransaction();

      this.logger.log(`지급 차이 반려: proposal=${proposal.id} batch=${batch.id}`);

      return { proposalId: proposal.id, status: 'REJECTED', rejectedAt: decisionAtDb };
    } catch (e) {
      await queryRunner.rollbackTransaction();
      throw e;
    } finally {
      await queryRunner.release();
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 공통
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * 잠금 순서 anchor → batch → payment request → proposal (정본 §5.7.2).
   * proposal 자체는 non-locking read 로 먼저 읽어 협력사·batch 만 식별한다.
   */
  private async lockDecisionScope(
    manager: EntityManager,
    id: number,
  ): Promise<{
    proposal: PartnerSettlePaymentVarianceProposalEntity;
    batch: PartnerSettleBatchEntity;
    request: PartnerSettlePaymentRequestEntity;
  }> {
    const preview = await manager
      .getRepository(PartnerSettlePaymentVarianceProposalEntity)
      .findOne({ where: { id } });
    if (!preview) throw new NotFoundException(`지급 차이 proposal ${id}을 찾을 수 없습니다.`);

    await manager
      .getRepository(PartnerCompanyEntity)
      .createQueryBuilder('pc')
      .setLock('pessimistic_write')
      .where('pc.id = :id', { id: preview.partnerCompanyId })
      .getOneOrFail();

    const batch = await manager
      .getRepository(PartnerSettleBatchEntity)
      .createQueryBuilder('b')
      .setLock('pessimistic_write')
      .where('b.id = :id', { id: preview.batchId })
      .getOne();
    if (!batch) throw new NotFoundException(`batch ${preview.batchId}을 찾을 수 없습니다.`);

    const request = await manager
      .getRepository(PartnerSettlePaymentRequestEntity)
      .createQueryBuilder('r')
      .setLock('pessimistic_write')
      .where('r.id = :id', { id: preview.paymentRequestId })
      .getOne();
    if (!request) throw new NotFoundException(`지급 요청 ${preview.paymentRequestId}을 찾을 수 없습니다.`);

    const proposal = await manager
      .getRepository(PartnerSettlePaymentVarianceProposalEntity)
      .createQueryBuilder('p')
      .setLock('pessimistic_write')
      .where('p.id = :id', { id })
      .getOne();
    if (!proposal) throw new NotFoundException(`지급 차이 proposal ${id}을 찾을 수 없습니다.`);

    // 잠금 전 read 와 어긋나면 대사 오류다(FK 가 막지만 방어적으로 확인).
    if (proposal.batchId !== batch.id || proposal.partnerCompanyId !== batch.partnerCompanyId) {
      throw new ConflictException(`proposal ${id}과 batch ${batch.id}의 귀속이 일치하지 않습니다.`);
    }

    return { proposal, batch, request };
  }

  /**
   * 지급예정액 재계산 — PR1D `paid()` 와 **같은 산식**이어야 한다.
   * carry 체인(직전 batch carryOut) + 확정 원장 재동결 합계.
   */
  private async recomputePayable(
    manager: EntityManager,
    batch: PartnerSettleBatchEntity,
  ): Promise<{
    carryInAmount: bigint;
    finalizedTotalAmount: bigint;
    calculatedPaidAmount: bigint;
    carryOutAmount: bigint;
  }> {
    const prevBatch = await manager
      .getRepository(PartnerSettleBatchEntity)
      .createQueryBuilder('b')
      .where('b.partnerCompanyId = :pcId', { pcId: batch.partnerCompanyId })
      .andWhere("b.batchType = 'NORMAL'")
      .andWhere("b.status <> 'CANCELED'")
      .andWhere('b.periodEnd < :pe', { pe: batch.periodEnd })
      .orderBy('b.periodEnd', 'DESC')
      .limit(1)
      .getOne();

    let carryInAmount = 0n;
    if (prevBatch) {
      if (prevBatch.status !== 'PAID' && prevBatch.status !== 'CANCELED') {
        throw new BadRequestException(
          `직전 batch (${prevBatch.id}, periodEnd=${prevBatch.periodEnd})가 아직 지급되지 않았습니다. 지급 순서: periodEnd 오름차순.`,
        );
      }
      if (prevBatch.carryOutAmount !== null) {
        carryInAmount = BigInt(prevBatch.carryOutAmount);
      }
    }

    const sumResult = await manager
      .createQueryBuilder()
      .select('COALESCE(SUM(CAST(l.settleAmount AS SIGNED)), 0)', 'total')
      .from(PartnerSettleLedgerEntity, 'l')
      .where('l.settleBatchId = :batchId', { batchId: batch.id })
      .getRawOne();
    const finalizedTotalAmount = BigInt(sumResult?.total ?? 0);

    const net = finalizedTotalAmount + carryInAmount;
    return {
      carryInAmount,
      finalizedTotalAmount,
      calculatedPaidAmount: net > 0n ? net : 0n,
      carryOutAmount: net < 0n ? net : 0n,
    };
  }

  /** 승인 재시도 응답 — 저장된 결과를 그대로 돌려준다(재계산·재기록 없음). */
  private async approvedResult(
    manager: EntityManager,
    proposal: PartnerSettlePaymentVarianceProposalEntity,
  ): Promise<Record<string, unknown>> {
    const varianceAmount = BigInt(proposal.actualPaidAmount) - BigInt(proposal.calculatedPaidAmount);
    const ledger =
      proposal.resultLedgerId === null
        ? null
        : await manager.getRepository(PartnerSettleLedgerEntity).findOne({ where: { id: proposal.resultLedgerId } });

    return {
      proposalId: proposal.id,
      status: 'APPROVED',
      resultLedgerId: proposal.resultLedgerId,
      varianceAmount: varianceAmount.toString(),
      adjustmentAmount: ledger?.settleAmount ?? (-varianceAmount).toString(),
      approvedAt: proposal.approvedAt === null ? null : this.formatDbDate(proposal.approvedAt),
    };
  }

  /**
   * DB 기준 `T_decision`. 마이크로초까지 문자열로 읽어 `KstInstant` 로 만든다.
   * 앱 서버 시계(`new Date()`)를 쓰면 원장 귀속 시각이 DB 트랜잭션 시각과 어긋난다.
   */
  private async readDbNow(manager: EntityManager): Promise<KstInstant> {
    const rows = await manager.query(`SELECT DATE_FORMAT(NOW(6), '%Y-%m-%d %H:%i:%s.%f') AS now6`);
    const now6 = rows?.[0]?.now6;
    if (!now6) throw new ConflictException('DB 기준 시각을 읽지 못했습니다.');
    return parseKstDateTime(String(now6));
  }

  private assertNotSelfDecision(
    proposal: PartnerSettlePaymentVarianceProposalEntity,
    actor: VarianceActor,
  ): void {
    if (proposal.proposedBy === actor.id) {
      throw new ForbiddenException('지급 차이는 기안자와 다른 사람이 결정해야 합니다.');
    }
  }

  private normalizeReason(dto: VarianceDecisionReqDto): string {
    const reason = (dto.decisionReason ?? '').normalize('NFC').trim();
    if (!reason) throw new BadRequestException('결정 사유(decisionReason)는 필수입니다.');
    return reason;
  }

  private assertEnabled(): void {
    if (!this.featureFlag.isPaidEnabled) {
      throw new NotFoundException('지급 API가 아직 활성화되지 않았습니다.');
    }
  }

  private async withRetry<T>(run: () => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
      try {
        return await run();
      } catch (e: any) {
        const isRetryable = e?.errno === 1213 || e?.errno === 1205;
        if (!isRetryable || attempt === MAX_RETRY) {
          if (isRetryable) {
            throw new HttpException(
              { message: 'PAYMENT_TRANSACTION_RETRY_EXHAUSTED', retryAfter: 1 },
              HttpStatus.SERVICE_UNAVAILABLE,
            );
          }
          throw e;
        }
        const jitter = Math.floor(Math.random() * RETRY_JITTERS_MS[attempt - 1]);
        await new Promise((r) => setTimeout(r, jitter));
      }
    }
    throw new Error('variance decision: unreachable');
  }

  /**
   * 승인·반려 감사. `partner_settle_review_audit` 는 `(ledgerId) XOR (manualLedgerProposalId)` CHECK 라
   * 지급 차이를 담을 슬롯이 없다. 회계 provenance 는 proposal 행(`approvedBy/At`·`rejectedBy/At`·
   * `decisionReason`·`resultLedgerId`)이 immutable 로 보존하므로, 운영 감사만 activity_log 에 남긴다.
   */
  private async writeAuditLog(
    manager: EntityManager,
    actionType: ActivityLogActionType,
    actor: VarianceActor,
    decisionAtDb: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const logId = await this.activityLogService.createLog(
      {
        userId: actor.id,
        userEmail: actor.email,
        method: 'POST',
        requestUrl: `/settle/partner-company/payment-variance-proposals/${params.proposalId}/${
          actionType === ActivityLogActionType.PARTNER_SETTLE_VARIANCE_APPROVE ? 'approve' : 'reject'
        }`,
        actionType,
        ipAddress: actor.ipAddress,
        statusCode: 200,
        result: ActivityLogResult.SUCCESS,
        responseTime: 0,
        requestParams: params,
      },
      manager,
    );

    // `createdAt` 은 `@CreateDateColumn` 이라 INSERT 시 DB 시계로 찍힌다. 그대로 두면 감사 시각이
    // proposal.approvedAt · ledger.occurredAt 과 마이크로초 단위로 갈라져 "세 값이 같다" 는 계약이 깨진다.
    // 같은 트랜잭션 안에서 T_decision 으로 맞춘다.
    await manager.query('UPDATE activity_log SET created_at = ? WHERE id = ?', [decisionAtDb, logId]);
  }

  /** 조회 응답 — 금액은 canonical 문자열, stale 은 비잠금 참고값이다. */
  private async toView(proposal: PartnerSettlePaymentVarianceProposalEntity): Promise<Record<string, unknown>> {
    const varianceAmount = BigInt(proposal.actualPaidAmount) - BigInt(proposal.calculatedPaidAmount);

    let stale = false;
    if (proposal.status === 'PENDING') {
      const batch = await this.dataSource
        .getRepository(PartnerSettleBatchEntity)
        .findOne({ where: { id: proposal.batchId } });
      if (batch) {
        try {
          const recomputed = await this.recomputePayable(this.dataSource.manager, batch);
          stale = recomputed.calculatedPaidAmount !== BigInt(proposal.calculatedPaidAmount);
        } catch {
          // 재계산 자체가 막히면(직전 batch 미지급 등) 승인 시점에 다시 판정된다. 조회는 힌트만 준다.
          stale = true;
        }
      }
    }

    return {
      id: proposal.id,
      batchId: proposal.batchId,
      partnerCompanyId: proposal.partnerCompanyId,
      paymentRequestId: proposal.paymentRequestId,
      status: proposal.status,
      calculatedPaidAmount: proposal.calculatedPaidAmount,
      actualPaidAmount: proposal.actualPaidAmount,
      varianceAmount: varianceAmount.toString(),
      paymentEvidenceRef: proposal.paymentEvidenceRef,
      memo: proposal.memo,
      proposedBy: proposal.proposedBy,
      proposedAt: this.formatDbDate(proposal.proposedAt),
      approvedBy: proposal.approvedBy,
      approvedAt: proposal.approvedAt === null ? null : this.formatDbDate(proposal.approvedAt),
      rejectedBy: proposal.rejectedBy,
      rejectedAt: proposal.rejectedAt === null ? null : this.formatDbDate(proposal.rejectedAt),
      decisionReason: proposal.decisionReason,
      resultLedgerId: proposal.resultLedgerId,
      stale,
    };
  }

  /** TypeORM 이 돌려준 `Date` 는 밀리초까지다. 표시용 문자열이며 저장 경로에는 쓰지 않는다. */
  private formatDbDate(value: Date): string {
    return toDbDateTimeString({ date: value, microsecondRemainder: 0 });
  }
}
