import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PartnerSettleBatchEntity } from '../../entity/partner.settle.batch.entity';
import { PartnerSettleLedgerEntity } from '../../entity/partner.settle.ledger.entity';
import { PartnerCompanyEntity } from '../../entity/partner.company.entity';
import { PartnerSettlePaymentRequestEntity } from '../../entity/partner.settle.payment.request.entity';
import { PartnerSettlePaymentVarianceProposalEntity } from '../../entity/partner.settle.payment.variance.proposal.entity';
import { PartnerSettleFeatureFlag } from './partner.settle.feature.flag';
import { computePayloadHash } from '../domain/proposal.hash';
import { PaidReqDto } from '../api/dto/batch.dto';

const PAID_HASH_VERSION = 'v1';
const MAX_RETRY = 3;
const RETRY_JITTERS_MS = [50, 100]; // full jitter ceilings for 1st, 2nd retry

/**
 * 지급(paid) 서비스 (정본 §5.2 · §5.7.1 · §5.7.2 · PR1D).
 *
 * paid 요청은 P6 잠금 순서(anchor → batch → payment request → variance proposal → ledger)를
 * 따르며, deadlock(1213)/lock-wait-timeout(1205) 시 최대 3회 재시도한다.
 */
@Injectable()
export class PartnerSettlePaymentService {
  private readonly logger = new Logger(PartnerSettlePaymentService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly featureFlag: PartnerSettleFeatureFlag,
  ) {}

  /**
   * PUT settle/partner-company/batches/:id/paid
   *
   * 일반 지급(actualPaidAmount == calculatedPaidAmount) → batch PAID 200.
   * variance(actualPaidAmount != calculatedPaidAmount) → proposal PENDING 202.
   */
  async paid(
    batchId: number,
    dto: PaidReqDto,
    actorId: number,
  ): Promise<{ statusCode: number; result: Record<string, unknown> }> {
    if (!this.featureFlag.isPaidEnabled) {
      throw new NotFoundException('지급 API가 아직 활성화되지 않았습니다.');
    }

    const actualPaidAmount = BigInt(dto.actualPaidAmount);
    const payloadHash = this.paidPayloadHash(batchId, dto);
    const evidenceRef = (dto.paymentEvidenceRef ?? '').normalize('NFC').trim();
    const memo = dto.memo ? dto.memo.normalize('NFC').trim() || null : null;

    for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
      try {
        return await this.paidTransaction(batchId, dto, actorId, actualPaidAmount, payloadHash, evidenceRef, memo);
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

    // unreachable
    throw new Error('paid: unreachable');
  }

  private async paidTransaction(
    batchId: number,
    dto: PaidReqDto,
    actorId: number,
    actualPaidAmount: bigint,
    payloadHash: string,
    evidenceRef: string,
    memo: string | null,
  ): Promise<{ statusCode: number; result: Record<string, unknown> }> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const manager = queryRunner.manager;

      // 1. non-locking read — batch 식별
      const batchPreview = await manager.getRepository(PartnerSettleBatchEntity).findOne({ where: { id: batchId } });
      if (!batchPreview) throw new NotFoundException(`batch ${batchId}을 찾을 수 없습니다.`);

      const partnerCompanyId = batchPreview.partnerCompanyId;

      // 2. P6 잠금 순서: anchor → batch → payment request → variance proposal → ledger
      // anchor FOR UPDATE
      await manager
        .getRepository(PartnerCompanyEntity)
        .createQueryBuilder('pc')
        .setLock('pessimistic_write')
        .where('pc.id = :id', { id: partnerCompanyId })
        .getOneOrFail();

      // batch FOR UPDATE
      const batch = await manager
        .getRepository(PartnerSettleBatchEntity)
        .createQueryBuilder('b')
        .setLock('pessimistic_write')
        .where('b.id = :id', { id: batchId })
        .getOne();
      if (!batch) throw new NotFoundException(`batch ${batchId}을 찾을 수 없습니다.`);

      // 3. paidRequestKey 멱등 검증 — batch 상태 검증보다 먼저 (멱등 재시도가 상태에 막히지 않도록)
      const existingByKey = await manager
        .getRepository(PartnerSettlePaymentRequestEntity)
        .createQueryBuilder('r')
        .setLock('pessimistic_write')
        .where('r.paidRequestKey = :key', { key: dto.paidRequestKey })
        .getOne();

      if (existingByKey) {
        if (existingByKey.batchId !== batchId) {
          throw new ConflictException('이 paidRequestKey는 다른 batch에서 사용되었습니다.');
        }
        if (existingByKey.payloadHash !== payloadHash) {
          throw new ConflictException('같은 paidRequestKey에 다른 payload가 이미 사용되었습니다.');
        }
        // 같은 batch, 같은 hash — status 에 따라 반환
        if (existingByKey.status === 'PAID') {
          await queryRunner.commitTransaction();
          return { statusCode: 200, result: { paymentRequestId: existingByKey.id, status: 'PAID' } };
        }
        if (existingByKey.status === 'PENDING_VARIANCE') {
          await queryRunner.commitTransaction();
          return { statusCode: 202, result: { paymentRequestId: existingByKey.id, status: 'PENDING_VARIANCE' } };
        }
        // REJECTED
        throw new ConflictException('이 paidRequestKey의 요청은 반려되었습니다.');
      }

      // 4. batch 상태 검증 (새 요청에만 적용 — 멱등 재시도는 위에서 반환됨)
      if (batch.status !== 'CONFIRMED_UNPAID') {
        throw new ConflictException(`batch ${batchId}은 ${batch.status} 상태라 지급할 수 없습니다.`);
      }
      if (batch.batchType !== 'NORMAL') {
        throw new ConflictException(`batch ${batchId}은 ${batch.batchType} 타입이라 지급할 수 없습니다.`);
      }

      // 5. PENDING_VARIANCE 존재 확인 (새 key인데 미해결 요청이 이미 있으면 차단)
      const pendingRequest = await manager
        .getRepository(PartnerSettlePaymentRequestEntity)
        .createQueryBuilder('r')
        .setLock('pessimistic_write')
        .where('r.batchId = :bid', { bid: batchId })
        .andWhere("r.status = 'PENDING_VARIANCE'")
        .getOne();

      if (pendingRequest) {
        throw new ConflictException('이 batch에 PENDING_VARIANCE 요청이 이미 존재합니다 (PAYMENT_VARIANCE_PENDING).');
      }

      // 6. carry 체인 — 직전 batch
      const prevBatch = await manager
        .getRepository(PartnerSettleBatchEntity)
        .createQueryBuilder('b')
        .where('b.partnerCompanyId = :pcId', { pcId: partnerCompanyId })
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

      // 7. finalizedTotalAmount 재동결
      const sumResult = await manager
        .createQueryBuilder()
        .select('COALESCE(SUM(CAST(l.settleAmount AS SIGNED)), 0)', 'total')
        .from(PartnerSettleLedgerEntity, 'l')
        .where('l.settleBatchId = :batchId', { batchId })
        .getRawOne();
      const finalizedTotalAmount = BigInt(sumResult?.total ?? 0);

      // 8. 계산
      const calculatedPaidAmount =
        finalizedTotalAmount + carryInAmount > 0n ? finalizedTotalAmount + carryInAmount : 0n;
      const carryOutAmount = finalizedTotalAmount + carryInAmount < 0n ? finalizedTotalAmount + carryInAmount : 0n;

      const now = new Date();

      // 9. 일반 지급 vs variance 분기
      if (actualPaidAmount === calculatedPaidAmount) {
        // ── 일반 지급 ──
        const request = manager.getRepository(PartnerSettlePaymentRequestEntity).create({
          paidRequestKey: dto.paidRequestKey,
          batchId,
          payloadHash,
          payloadHashVersion: PAID_HASH_VERSION,
          status: 'PAID',
        });
        const savedRequest = await manager.getRepository(PartnerSettlePaymentRequestEntity).save(request);

        // batch PAID 전이
        await manager.getRepository(PartnerSettleBatchEntity).update(batchId, {
          status: 'PAID',
          paidAt: now,
          paidBy: actorId,
          paymentEvidenceRef: evidenceRef || (calculatedPaidAmount === 0n ? '0원 상계' : evidenceRef),
          paymentRequestId: savedRequest.id,
          paidRequestKey: dto.paidRequestKey,
          paidPayloadHash: payloadHash,
          paidPayloadHashVersion: PAID_HASH_VERSION,
          carryInAmount: carryInAmount.toString(),
          finalizedTotalAmount: finalizedTotalAmount.toString(),
          carryOutAmount: carryOutAmount.toString(),
          paidAmount: calculatedPaidAmount.toString(),
          calculatedPaidAmount: calculatedPaidAmount.toString(),
          actualPaidAmount: actualPaidAmount.toString(),
        });

        await queryRunner.commitTransaction();
        return {
          statusCode: 200,
          result: {
            paymentRequestId: savedRequest.id,
            status: 'PAID',
            paidAmount: calculatedPaidAmount.toString(),
            carryInAmount: carryInAmount.toString(),
            carryOutAmount: carryOutAmount.toString(),
            finalizedTotalAmount: finalizedTotalAmount.toString(),
          },
        };
      } else {
        // ── variance → proposal PENDING ──
        const request = manager.getRepository(PartnerSettlePaymentRequestEntity).create({
          paidRequestKey: dto.paidRequestKey,
          batchId,
          payloadHash,
          payloadHashVersion: PAID_HASH_VERSION,
          status: 'PENDING_VARIANCE',
        });
        const savedRequest = await manager.getRepository(PartnerSettlePaymentRequestEntity).save(request);

        const proposal = manager.getRepository(PartnerSettlePaymentVarianceProposalEntity).create({
          paymentRequestId: savedRequest.id,
          batchId,
          partnerCompanyId,
          calculatedPaidAmount: calculatedPaidAmount.toString(),
          actualPaidAmount: actualPaidAmount.toString(),
          paymentEvidenceRef: evidenceRef,
          memo,
          proposedBy: actorId,
          proposedAt: now,
          status: 'PENDING',
        });
        await manager.getRepository(PartnerSettlePaymentVarianceProposalEntity).save(proposal);

        await queryRunner.commitTransaction();
        return {
          statusCode: 202,
          result: {
            paymentRequestId: savedRequest.id,
            proposalId: proposal.id,
            status: 'PENDING_VARIANCE',
            calculatedPaidAmount: calculatedPaidAmount.toString(),
            actualPaidAmount: actualPaidAmount.toString(),
          },
        };
      }
    } catch (e) {
      await queryRunner.rollbackTransaction();
      throw e;
    } finally {
      await queryRunner.release();
    }
  }

  private paidPayloadHash(batchId: number, dto: PaidReqDto): string {
    return computePayloadHash(
      {
        batchId,
        paymentEvidenceRef: (dto.paymentEvidenceRef ?? '').normalize('NFC').trim(),
        actualPaidAmount: dto.actualPaidAmount,
        memo: dto.memo ? dto.memo.normalize('NFC').trim() || null : null,
      },
      PAID_HASH_VERSION,
    );
  }
}
