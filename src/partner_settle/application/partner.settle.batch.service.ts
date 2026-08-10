import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { PartnerSettleBatchEntity } from '../../entity/partner.settle.batch.entity';
import { PartnerSettleBatchReleaseEntity } from '../../entity/partner.settle.batch.release.entity';
import { PartnerSettleBatchReleaseRequestEntity } from '../../entity/partner.settle.batch.release.request.entity';
import { PartnerSettleExclusionEntity } from '../../entity/partner.settle.exclusion.entity';
import { PartnerSettleConfigEntity } from '../../entity/partner.settle.config.entity';
import { PartnerSettleCancelReconEntity } from '../../entity/partner.settle.cancel.recon.entity';
import { PartnerSettleLedgerEntity } from '../../entity/partner.settle.ledger.entity';
import { PartnerCompanyEntity } from '../../entity/partner.company.entity';
import { PartnerProviderEventInboxEntity } from '../../entity/partner.provider.event.inbox.entity';
import { PartnerSettleFeatureFlag } from './partner.settle.feature.flag';
import { computePayloadHash } from '../domain/proposal.hash';
import {
  BatchQueryDto,
  BatchSummaryResDto,
  ConfirmReqDto,
  ConfirmResDto,
  UnconfirmReqDto,
  UnconfirmResDto,
} from '../api/dto/batch.dto';

const CONFIRM_HASH_VERSION = 'v1';
const UNCONFIRM_HASH_VERSION = 'v2';
/** bounded chunk size for large month UPDATE (§5.2 33차-M2) */
const CHUNK_SIZE = 50_000;

@Injectable()
export class PartnerSettleBatchService {
  private readonly logger = new Logger(PartnerSettleBatchService.name);

  constructor(
    @InjectRepository(PartnerSettleBatchEntity)
    private readonly batchRepo: Repository<PartnerSettleBatchEntity>,
    @InjectRepository(PartnerSettleConfigEntity)
    private readonly configRepo: Repository<PartnerSettleConfigEntity>,
    private readonly dataSource: DataSource,
    private readonly featureFlag: PartnerSettleFeatureFlag,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════
  //  confirm — 확정 sweep (§5.2)
  // ═══════════════════════════════════════════════════════════════════════

  async confirm(dto: ConfirmReqDto, actorId: number): Promise<ConfirmResDto> {
    this.assertConfirmEnabled();

    const payloadHash = this.confirmPayloadHash(dto);

    // READ COMMITTED 격리수준으로 트랜잭션 시작 (§5.2 29차-5 → 30차-1)
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('READ COMMITTED');

    try {
      const manager = queryRunner.manager;

      // 1. 협력사 anchor FOR UPDATE (직렬화)
      await manager
        .getRepository(PartnerCompanyEntity)
        .createQueryBuilder('pc')
        .setLock('pessimistic_write')
        .where('pc.id = :id', { id: dto.partnerCompanyId })
        .getOneOrFail()
        .catch(() => {
          throw new NotFoundException(`협력사 ${dto.partnerCompanyId}을 찾을 수 없습니다.`);
        });

      // 2. 멱등 검증 — requestKey 기존 batch 조회
      const existingByKey = await manager
        .getRepository(PartnerSettleBatchEntity)
        .findOne({ where: { requestKey: dto.requestKey } });

      if (existingByKey) {
        if (existingByKey.payloadHash === payloadHash) {
          // 같은 key·같은 hash → 기존 batch 200
          await queryRunner.commitTransaction();
          return this.toConfirmRes(existingByKey, manager);
        }
        throw new ConflictException('같은 requestKey에 다른 payload가 이미 사용되었습니다.');
      }

      // 3. periodEnd 진행 순서 검증
      await this.validatePeriodEnd(dto.partnerCompanyId, dto.periodEnd, manager);

      // 4. orphan fail-closed (68차-B1)
      await this.assertNoOrphanPending(dto.partnerCompanyId, manager);

      // 5. 대상 id 확보 — FOR UPDATE
      const sweepCondition = {
        partnerCompanyId: dto.partnerCompanyId,
        periodEnd: dto.periodEnd,
      };

      const targetRows: { id: number }[] = await manager
        .createQueryBuilder()
        .select('l.id', 'id')
        .from(PartnerSettleLedgerEntity, 'l')
        .where('l.partnerCompanyId = :pcId', { pcId: sweepCondition.partnerCompanyId })
        .andWhere('l.settleBatchId IS NULL')
        .andWhere("l.status = 'NORMAL'")
        .andWhere('l.occurredAt < :periodEnd', { periodEnd: sweepCondition.periodEnd })
        .setLock('pessimistic_write')
        .getRawMany();

      // 6. excludeItems 처리
      const excludeSet = new Set<number>();
      const excludeItems = dto.excludeItems ?? [];

      if (excludeItems.length > 0) {
        const targetIdSet = new Set(targetRows.map((r) => r.id));
        for (const item of excludeItems) {
          if (!targetIdSet.has(item.ledgerId)) {
            throw new BadRequestException(`제외 대상 ledgerId ${item.ledgerId}이 확정 대상 집합에 속하지 않습니다.`);
          }
          excludeSet.add(item.ledgerId);
        }
      }

      const confirmIds = targetRows.map((r) => r.id).filter((id) => !excludeSet.has(id));

      // 7. batch INSERT
      const now = new Date();
      const batch = manager.getRepository(PartnerSettleBatchEntity).create({
        partnerCompanyId: dto.partnerCompanyId,
        periodEnd: dto.periodEnd,
        confirmedBy: actorId,
        confirmedAt: now,
        confirmedTotalAmount: '0',
        confirmedCount: 0,
        status: 'CONFIRMED_UNPAID',
        batchType: 'NORMAL',
        requestKey: dto.requestKey,
        payloadHash,
        payloadHashVersion: CONFIRM_HASH_VERSION,
      });
      const savedBatch = await manager.getRepository(PartnerSettleBatchEntity).save(batch);

      // 8. 대상 row 에 batchId 부여 — bounded chunk UPDATE
      if (confirmIds.length > 0) {
        let totalAffected = 0;
        for (let offset = 0; offset < confirmIds.length; offset += CHUNK_SIZE) {
          const chunk = confirmIds.slice(offset, offset + CHUNK_SIZE);
          const result = await manager
            .createQueryBuilder()
            .update(PartnerSettleLedgerEntity)
            .set({ settleBatchId: savedBatch.id })
            .where('id IN (:...ids)', { ids: chunk })
            .andWhere('settleBatchId IS NULL')
            .execute();
          totalAffected += result.affected ?? 0;
        }

        if (totalAffected !== confirmIds.length) {
          throw new ConflictException(
            `확정 대상 affected rows 불일치: expected ${confirmIds.length}, got ${totalAffected}`,
          );
        }
      }

      // 9. 동결값 저장
      let confirmedTotalAmount = 0n;
      if (confirmIds.length > 0) {
        const sumResult = await manager
          .createQueryBuilder()
          .select('SUM(CAST(l.settleAmount AS SIGNED))', 'total')
          .from(PartnerSettleLedgerEntity, 'l')
          .where('l.settleBatchId = :batchId', { batchId: savedBatch.id })
          .getRawOne();
        confirmedTotalAmount = BigInt(sumResult?.total ?? 0);
      }

      await manager.getRepository(PartnerSettleBatchEntity).update(savedBatch.id, {
        confirmedTotalAmount: confirmedTotalAmount.toString(),
        confirmedCount: confirmIds.length,
      });
      savedBatch.confirmedTotalAmount = confirmedTotalAmount.toString();
      savedBatch.confirmedCount = confirmIds.length;

      // 10. HOLD 처리 — ON_HOLD 전이
      for (const item of excludeItems) {
        if (item.mode === 'HOLD') {
          await manager.getRepository(PartnerSettleLedgerEntity).update(item.ledgerId, { status: 'ON_HOLD' });
        }
      }

      // 11. exclusion 감사 row
      if (excludeItems.length > 0) {
        const exclusions = excludeItems.map((item) =>
          manager.getRepository(PartnerSettleExclusionEntity).create({
            batchId: savedBatch.id,
            ledgerId: item.ledgerId,
            action: item.mode,
            reason: item.reason,
            actedBy: actorId,
            actedAt: now,
          }),
        );
        await manager.getRepository(PartnerSettleExclusionEntity).save(exclusions);
      }

      // 12. cancel_recon 원자 등록 (§7.2 · 33차-6)
      await this.registerCancelRecon(confirmIds, savedBatch, manager);

      await queryRunner.commitTransaction();
      return this.toConfirmRes(savedBatch, manager);
    } catch (e) {
      await queryRunner.rollbackTransaction();
      throw e;
    } finally {
      await queryRunner.release();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  unconfirm — 건별/배치 해제 (§5.8)
  // ═══════════════════════════════════════════════════════════════════════

  async unconfirm(pathBatchId: number, dto: UnconfirmReqDto, actorId: number): Promise<UnconfirmResDto> {
    this.assertConfirmEnabled();

    const payloadHash = this.unconfirmPayloadHash(pathBatchId, dto);
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const manager = queryRunner.manager;

      // 1. 멱등 검증
      const existingReq = await manager
        .getRepository(PartnerSettleBatchReleaseRequestEntity)
        .findOne({ where: { requestKey: dto.requestKey } });

      if (existingReq) {
        if (existingReq.payloadHash === payloadHash) {
          const releases = await manager
            .getRepository(PartnerSettleBatchReleaseEntity)
            .find({ where: { releaseRequestId: existingReq.id } });
          await queryRunner.commitTransaction();
          return { releasedCount: releases.length, requestId: existingReq.id };
        }
        throw new ConflictException('같은 requestKey에 다른 payload가 이미 사용되었습니다.');
      }

      // 2. 대상 ledger ids 결정
      let targetLedgerIds: number[];

      if (dto.ledgerIds && dto.ledgerIds.length > 0) {
        targetLedgerIds = dto.ledgerIds;
      } else {
        const previewList = await manager.getRepository(PartnerSettleLedgerEntity).find({
          select: ['id'],
          where: { settleBatchId: pathBatchId },
        });
        targetLedgerIds = previewList.map((l) => l.id);
      }

      if (targetLedgerIds.length === 0) {
        throw new BadRequestException('해제 대상이 없습니다.');
      }

      // 3. 잠금 순서 통일: anchor → batch → ledger (paid 경로와 동일, §P6)
      //    non-locking preview 는 anchor(=partnerId) 식별에만 쓴다.
      //    settleBatchId 는 anchor 획득 전엔 신뢰 불가 — 경쟁 confirm 이
      //    NULL→batch 로 귀속시킬 수 있으므로, batch ID 는 anchor 아래에서 재확정한다.
      const previewLedgers = await manager
        .getRepository(PartnerSettleLedgerEntity)
        .createQueryBuilder('l')
        .select(['l.id', 'l.partnerCompanyId'])
        .where('l.id IN (:...ids)', { ids: targetLedgerIds })
        .getMany();

      if (previewLedgers.length !== targetLedgerIds.length) {
        throw new NotFoundException('일부 ledger를 찾을 수 없습니다.');
      }

      const previewPartnerIds = new Set(previewLedgers.map((l) => l.partnerCompanyId));
      if (previewPartnerIds.size > 1) {
        throw new BadRequestException('동일 협력사의 ledger만 해제할 수 있습니다.');
      }
      const partnerId = [...previewPartnerIds][0];

      // 3a. anchor FOR UPDATE (paid 경로와 동일한 최선 잠금)
      //     이 이후로 confirm/unconfirm 의 귀속 변경은 직렬화된다.
      await manager
        .getRepository(PartnerCompanyEntity)
        .createQueryBuilder('pc')
        .setLock('pessimistic_write')
        .where('pc.id = :id', { id: partnerId })
        .getOneOrFail();

      // 3a-2. anchor 아래에서 현재 settleBatchId 재확정 (경쟁 confirm 반영)
      const anchoredLedgers = await manager
        .getRepository(PartnerSettleLedgerEntity)
        .createQueryBuilder('l')
        .select(['l.id', 'l.settleBatchId'])
        .where('l.id IN (:...ids)', { ids: targetLedgerIds })
        .getMany();
      const targetBatchIds = [...new Set(
        anchoredLedgers.filter((l) => l.settleBatchId !== null).map((l) => l.settleBatchId!),
      )];

      // 3b. batch FOR UPDATE (id 오름차순)
      const batches = targetBatchIds.length > 0
        ? await manager
            .getRepository(PartnerSettleBatchEntity)
            .createQueryBuilder('b')
            .setLock('pessimistic_write')
            .where('b.id IN (:...ids)', { ids: targetBatchIds })
            .orderBy('b.id', 'ASC')
            .getMany()
        : [];

      // 3c. ledger FOR UPDATE (잠금 순서 마지막)
      const ledgers = await manager
        .getRepository(PartnerSettleLedgerEntity)
        .createQueryBuilder('l')
        .setLock('pessimistic_write')
        .where('l.id IN (:...ids)', { ids: targetLedgerIds })
        .getMany();

      // 4. 잠금 후 검증
      if (ledgers.length !== targetLedgerIds.length) {
        throw new NotFoundException('일부 ledger를 찾을 수 없습니다.');
      }

      const partnerIds = new Set(ledgers.map((l) => l.partnerCompanyId));
      if (partnerIds.size > 1) {
        throw new BadRequestException('동일 협력사의 ledger만 해제할 수 있습니다.');
      }

      for (const ledger of ledgers) {
        if (ledger.settleBatchId === null) {
          throw new ConflictException(`ledger ${ledger.id}은 이미 미정산 상태입니다.`);
        }
      }

      // 5. batch 전제 검증 — CONFIRMED_UNPAID + NORMAL 만

      for (const batch of batches) {
        if (batch.status !== 'CONFIRMED_UNPAID') {
          throw new ConflictException(`batch ${batch.id}은 ${batch.status} 상태라 해제할 수 없습니다.`);
        }
        if (batch.batchType !== 'NORMAL') {
          throw new ConflictException(`batch ${batch.id}은 ${batch.batchType} 타입이라 해제할 수 없습니다.`);
        }

        // carry 체인 무결성: 뒤에 비CANCELED batch 존재 여부
        const laterBatch = await manager
          .getRepository(PartnerSettleBatchEntity)
          .createQueryBuilder('b')
          .where('b.partnerCompanyId = :pcId', { pcId: batch.partnerCompanyId })
          .andWhere("b.batchType = 'NORMAL'")
          .andWhere("b.status <> 'CANCELED'")
          .andWhere('b.periodEnd > :pe', { pe: batch.periodEnd })
          .limit(1)
          .getOne();

        if (laterBatch) {
          throw new ConflictException(
            `batch ${batch.id} 뒤에 비CANCELED batch (${laterBatch.id})가 존재해 해제할 수 없습니다.`,
          );
        }
      }

      // 6. release request INSERT
      const now = new Date();
      const releaseReq = manager.getRepository(PartnerSettleBatchReleaseRequestEntity).create({
        requestKey: dto.requestKey,
        payloadHash,
        payloadHashVersion: UNCONFIRM_HASH_VERSION,
        releasedBy: actorId,
        releasedAt: now,
      });
      const savedReq = await manager.getRepository(PartnerSettleBatchReleaseRequestEntity).save(releaseReq);

      // 7. ledger settleBatchId → NULL + release audit row
      for (const ledger of ledgers) {
        await manager.getRepository(PartnerSettleLedgerEntity).update(ledger.id, { settleBatchId: null });

        const release = manager.getRepository(PartnerSettleBatchReleaseEntity).create({
          batchId: ledger.settleBatchId!,
          ledgerId: ledger.id,
          releaseRequestId: savedReq.id,
          releasedBy: actorId,
          releasedAt: now,
          reason: dto.reason,
        });
        await manager.getRepository(PartnerSettleBatchReleaseEntity).save(release);
      }

      // 8. cancel_recon INACTIVE 처리
      for (const ledger of ledgers) {
        await manager
          .getRepository(PartnerSettleCancelReconEntity)
          .update({ ledgerId: ledger.id, status: 'ACTIVE' }, { status: 'INACTIVE' });
      }

      // 9. batch 유효 항목 0건 → CANCELED 전이
      for (const batch of batches) {
        const remaining = await manager
          .getRepository(PartnerSettleLedgerEntity)
          .count({ where: { settleBatchId: batch.id } });

        if (remaining === 0) {
          await manager.getRepository(PartnerSettleBatchEntity).update(batch.id, {
            status: 'CANCELED',
            canceledBy: actorId,
            canceledAt: now,
          });
        }
      }

      await queryRunner.commitTransaction();
      return { releasedCount: ledgers.length, requestId: savedReq.id };
    } catch (e) {
      await queryRunner.rollbackTransaction();
      throw e;
    } finally {
      await queryRunner.release();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  holdRelease — ON_HOLD 해제 (§5.9)
  // ═══════════════════════════════════════════════════════════════════════

  async holdRelease(ledgerId: number, reason: string, actorId: number): Promise<void> {
    this.assertConfirmEnabled();

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const manager = queryRunner.manager;

      const ledger = await manager
        .getRepository(PartnerSettleLedgerEntity)
        .createQueryBuilder('l')
        .setLock('pessimistic_write')
        .where('l.id = :id', { id: ledgerId })
        .getOne();

      if (!ledger) throw new NotFoundException(`ledger ${ledgerId}을 찾을 수 없습니다.`);
      if (ledger.status !== 'ON_HOLD') {
        throw new BadRequestException(`ledger ${ledgerId}은 ON_HOLD 상태가 아닙니다 (현재: ${ledger.status}).`);
      }

      await manager.getRepository(PartnerSettleLedgerEntity).update(ledgerId, { status: 'NORMAL' });

      const exclusion = manager.getRepository(PartnerSettleExclusionEntity).create({
        batchId: null,
        ledgerId,
        action: 'HOLD_RELEASE',
        reason,
        actedBy: actorId,
        actedAt: new Date(),
      });
      await manager.getRepository(PartnerSettleExclusionEntity).save(exclusion);

      await queryRunner.commitTransaction();
    } catch (e) {
      await queryRunner.rollbackTransaction();
      throw e;
    } finally {
      await queryRunner.release();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  조회
  // ═══════════════════════════════════════════════════════════════════════

  async findBatches(query: BatchQueryDto): Promise<BatchSummaryResDto[]> {
    const qb = this.batchRepo.createQueryBuilder('b');
    if (query.partnerCompanyId) {
      qb.andWhere('b.partnerCompanyId = :pcId', { pcId: query.partnerCompanyId });
    }
    if (query.status) {
      qb.andWhere('b.status = :status', { status: query.status });
    }
    qb.orderBy('b.periodEnd', 'DESC').addOrderBy('b.id', 'DESC');
    const batches = await qb.getMany();
    return batches.map((b) => this.toBatchSummary(b));
  }

  async findBatch(batchId: number): Promise<BatchSummaryResDto & { currentTotalAmount: string; currentCount: number }> {
    const batch = await this.batchRepo.findOne({ where: { id: batchId } });
    if (!batch) throw new NotFoundException(`batch ${batchId}을 찾을 수 없습니다.`);

    // 현재 유효 합계
    const result = await this.batchRepo.manager
      .createQueryBuilder()
      .select('COALESCE(SUM(CAST(l.settleAmount AS SIGNED)), 0)', 'total')
      .addSelect('COUNT(*)', 'cnt')
      .from(PartnerSettleLedgerEntity, 'l')
      .where('l.settleBatchId = :batchId', { batchId })
      .getRawOne();

    return {
      ...this.toBatchSummary(batch),
      currentTotalAmount: (result?.total ?? '0').toString(),
      currentCount: Number(result?.cnt ?? 0),
    };
  }

  async findConfig(
    partnerCompanyId: number,
  ): Promise<{ partnerCompanyId: number; nextNormalPeriodEnd: string; source: string } | null> {
    const config = await this.configRepo.findOne({ where: { partnerCompanyId } });
    if (!config) return null;
    return {
      partnerCompanyId: config.partnerCompanyId,
      nextNormalPeriodEnd: config.nextNormalPeriodEnd,
      source: config.source,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  internal helpers
  // ═══════════════════════════════════════════════════════════════════════

  private assertConfirmEnabled(): void {
    if (!this.featureFlag.isConfirmEnabled) {
      throw new NotFoundException('정산확정 API가 아직 활성화되지 않았습니다.');
    }
  }

  /** periodEnd 진행 순서 검증 (§5.2 3차 H2 · 28차 BLOCK) */
  private async validatePeriodEnd(partnerCompanyId: number, periodEnd: string, manager: EntityManager): Promise<void> {
    // config 확인
    const config = await manager.getRepository(PartnerSettleConfigEntity).findOne({ where: { partnerCompanyId } });

    if (!config) {
      throw new BadRequestException(`협력사 ${partnerCompanyId}에 partner_settle_config가 설정되어 있지 않습니다.`);
    }

    // 직전 비CANCELED NORMAL batch
    const prevBatch = await manager
      .getRepository(PartnerSettleBatchEntity)
      .createQueryBuilder('b')
      .where('b.partnerCompanyId = :pcId', { pcId: partnerCompanyId })
      .andWhere("b.batchType = 'NORMAL'")
      .andWhere("b.status <> 'CANCELED'")
      .orderBy('b.periodEnd', 'DESC')
      .limit(1)
      .getOne();

    if (!prevBatch) {
      // 최초 confirm: periodEnd == nextNormalPeriodEnd 만 허용
      if (periodEnd !== config.nextNormalPeriodEnd) {
        throw new BadRequestException(
          `최초 확정의 periodEnd는 ${config.nextNormalPeriodEnd}이어야 합니다 (요청: ${periodEnd}).`,
        );
      }
      return;
    }

    // 후속: periodEnd == 직전.periodEnd + 1개월
    const expectedNext = this.addOneMonth(prevBatch.periodEnd);
    if (periodEnd !== expectedNext) {
      throw new BadRequestException(
        `periodEnd는 ${expectedNext}이어야 합니다 (요청: ${periodEnd}, 직전: ${prevBatch.periodEnd}).`,
      );
    }
  }

  /** orphan fail-closed (68차-B1) */
  private async assertNoOrphanPending(partnerCompanyId: number, manager: EntityManager): Promise<void> {
    // 해당 협력사의 ORPHAN_PENDING inbox 존재 확인
    // inbox 의 provider 는 partnerCompanyId 와 직접 매핑되지 않으므로,
    // partnerCompanyId → partner_company.type 으로 provider 결정 후 조회
    const company = await manager.getRepository(PartnerCompanyEntity).findOne({
      where: { id: partnerCompanyId },
      select: ['id', 'type'],
    });
    if (!company) return;

    const orphanCount = await manager
      .getRepository(PartnerProviderEventInboxEntity)
      .createQueryBuilder('inbox')
      .where('inbox.provider = :provider', { provider: company.type })
      .andWhere("inbox.origin = 'ORPHAN'")
      .andWhere("inbox.processedStatus = 'ORPHAN_PENDING'")
      .getCount();

    if (orphanCount > 0) {
      throw new ConflictException(
        `협력사 ${partnerCompanyId}에 미해소 orphan 사건이 ${orphanCount}건 있어 확정할 수 없습니다 (ORPHAN_PENDING_EXISTS).`,
      );
    }
  }

  /** cancel_recon 등록 (확정 귀속과 같은 TX, §7.2 · 33차-6) */
  private async registerCancelRecon(
    confirmIds: number[],
    batch: PartnerSettleBatchEntity,
    manager: EntityManager,
  ): Promise<void> {
    if (confirmIds.length === 0) return;

    // eligibility: sourceType != ADJUSTMENT, orderDeliveryId IS NOT NULL,
    // baseAmount > 0, reversesLedgerId IS NULL, provider != SSG
    // SSG 는 교환취소 미관리 (43차)
    const eligible = await manager
      .createQueryBuilder()
      .select('l.id', 'id')
      .addSelect('od.expireAt', 'expireAt')
      .from(PartnerSettleLedgerEntity, 'l')
      .leftJoin('order_delivery', 'od', 'od.id = l.orderDeliveryId')
      .where('l.id IN (:...ids)', { ids: confirmIds })
      .andWhere("l.sourceType <> 'ADJUSTMENT'")
      .andWhere('l.orderDeliveryId IS NOT NULL')
      .andWhere('CAST(l.baseAmount AS SIGNED) > 0')
      .andWhere('l.reversesLedgerId IS NULL')
      .getRawMany<{ id: number; expireAt: Date | null }>();

    // SSG 필터링 — partner_company type 확인이 필요하지만,
    // confirm 은 단일 협력사이므로 batch.partnerCompanyId 로 한 번만 확인
    const company = await manager.getRepository(PartnerCompanyEntity).findOne({
      where: { id: batch.partnerCompanyId },
      select: ['id', 'type'],
    });
    const isSsg = company?.type === 'SSG';

    if (isSsg) return; // SSG 전체 미등록

    const graceDays = 7; // env 에서 읽어야 하나 PR1D 는 등록만 담당, worker 는 PR1E
    const cancelCapDays = 1825; // 5년 fallback

    const recons: Partial<PartnerSettleCancelReconEntity>[] = [];
    for (const row of eligible) {
      let candidateUntil: Date;
      if (row.expireAt) {
        candidateUntil = new Date(row.expireAt.getTime() + graceDays * 24 * 60 * 60 * 1000);
      } else {
        candidateUntil = new Date(batch.confirmedAt.getTime() + cancelCapDays * 24 * 60 * 60 * 1000);
      }
      recons.push({
        ledgerId: row.id,
        candidateUntil,
        status: 'ACTIVE',
        retryCount: 0,
      });
    }

    if (recons.length > 0) {
      // INSERT IGNORE 로 이미 존재하는 경우 스킵 (재시도 안전)
      await manager
        .createQueryBuilder()
        .insert()
        .into(PartnerSettleCancelReconEntity)
        .values(recons)
        .orIgnore()
        .execute();
    }
  }

  /** KST date string 에 1개월 추가 */
  private addOneMonth(dateStr: string): string {
    const d = new Date(dateStr + 'T00:00:00+09:00');
    d.setMonth(d.getMonth() + 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  /** confirm payload hash */
  private confirmPayloadHash(dto: ConfirmReqDto): string {
    const excludeItems = (dto.excludeItems ?? [])
      .slice()
      .sort((a, b) => a.ledgerId - b.ledgerId)
      .map((item) => ({
        ledgerId: item.ledgerId,
        reason: (item.reason ?? '').normalize('NFC').trim(),
        mode: item.mode,
      }));

    return computePayloadHash(
      {
        partnerCompanyId: dto.partnerCompanyId,
        periodEnd: dto.periodEnd,
        excludeItems,
      },
      CONFIRM_HASH_VERSION,
    );
  }

  /** unconfirm payload hash (v2: pathBatchId 포함) */
  private unconfirmPayloadHash(pathBatchId: number, dto: UnconfirmReqDto): string {
    const fields: Record<string, unknown> = {
      pathBatchId,
      reason: (dto.reason ?? '').normalize('NFC').trim(),
    };
    if (dto.batchId !== undefined) {
      fields.batchId = dto.batchId;
    }
    if (dto.ledgerIds) {
      fields.ledgerIds = [...dto.ledgerIds].sort((a, b) => a - b);
    }
    return computePayloadHash(fields, UNCONFIRM_HASH_VERSION);
  }

  private async toConfirmRes(batch: PartnerSettleBatchEntity, manager: EntityManager): Promise<ConfirmResDto> {
    // estimatedPayableAmount 계산
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

    let carryEstimate = 0n;
    let isProvisional = false;
    if (prevBatch) {
      if (prevBatch.carryOutAmount !== null) {
        carryEstimate = BigInt(prevBatch.carryOutAmount);
      } else {
        isProvisional = true;
      }
    }

    const confirmed = BigInt(batch.confirmedTotalAmount);
    const estimated = confirmed + carryEstimate;
    const payable = estimated > 0n ? estimated : 0n;

    return {
      batchId: batch.id,
      confirmedTotalAmount: batch.confirmedTotalAmount,
      confirmedCount: batch.confirmedCount,
      estimatedPayableAmount: payable.toString(),
      isEstimateProvisional: isProvisional || undefined,
    };
  }

  private toBatchSummary(batch: PartnerSettleBatchEntity): BatchSummaryResDto {
    return {
      id: batch.id,
      partnerCompanyId: batch.partnerCompanyId,
      periodEnd: batch.periodEnd,
      status: batch.status,
      batchType: batch.batchType,
      confirmedTotalAmount: batch.confirmedTotalAmount,
      confirmedCount: batch.confirmedCount,
      finalizedTotalAmount: batch.finalizedTotalAmount,
      paidAmount: batch.paidAmount,
    };
  }
}
