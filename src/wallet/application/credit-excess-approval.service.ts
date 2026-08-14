import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, LessThan, Repository } from 'typeorm';
import {
  CREDIT_EXCESS_ACTIVE_STATUSES,
  CreditExcessApprovalEntity,
  CreditExcessApprovalStatus,
} from '../../entity/credit.excess.approval.entity';
import { CreditExcessApprovalExecutionEntity } from '../../entity/credit.excess.approval.execution.entity';
import { UserEntity } from '../../entity/user.entity';
import {
  CreditExcessApprovalClaimConflictError,
  CreditExcessApprovalDriftError,
} from './credit-excess-approval.errors';

export interface CreateCreditExcessApprovalInput {
  orderId: number;
  walletAccountId: string | null;
  requestedAmount: number;
  requestedCreditExcessAmount: number;
  reasonText: string;
  requestedBy: number;
  snapshotVersion: number;
  snapshot: Record<string, unknown>;
}

export interface CreditExcessApprovalListItem {
  id: string;
  orderId: number;
  requesterName: string;
  requesterCompanyName: string;
  requestedAt: string;
  requestedAmount: number;
  requestedCreditExcessAmount: number;
  reasonText: string;
  status: CreditExcessApprovalStatus;
  approverName: string | null;
  rejectReason: string | null;
  userMessage: string | null;
  changedFields: string[] | null;
  /** 운영자 전용 진단 (요청자 조회 시 undefined) */
  diagnosticCode?: string | null;
  internalReason?: string | null;
  processingStartedAt?: string | null;
  finishedAt?: string | null;
  attemptCount?: number;
}

/**
 * 신용초과 승인 **상태 저장소**.
 *
 * 승인 실행(발송확정 orchestration)은 OrderModule 이 소유한다. 본 서비스는 approval row 의
 * 상태 전이·선점·실행 표식만 담당하며 OrderService 를 알지 않는다 (모듈 순환 차단).
 *
 * 상태 머신:
 *   PENDING → PROCESSING → COMPLETED | FAILED | RE_REQUEST_REQUIRED
 *   PENDING → REJECTED | EXPIRED
 */
@Injectable()
export class CreditExcessApprovalService {
  /** PROCESSING lease 기본 수명. 만료 시 복구 작업이 실행 표식으로 결과를 판정한다. */
  static readonly LEASE_MS = 5 * 60 * 1000;

  constructor(
    @InjectRepository(CreditExcessApprovalEntity)
    private readonly approvalRepository: Repository<CreditExcessApprovalEntity>,
    @InjectRepository(CreditExcessApprovalExecutionEntity)
    private readonly executionRepository: Repository<CreditExcessApprovalExecutionEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  // ===== 조회 =====

  /** 운영자 목록 조회. status 기본 PENDING. */
  async list(
    query: { status?: CreditExcessApprovalStatus; page?: number; take?: number },
    scope: { requestedBy?: number; includeDiagnostics: boolean },
  ): Promise<{
    list: CreditExcessApprovalListItem[];
    totalCount: number;
    totalPage: number;
    currentPage: number;
  }> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const take = query.take && query.take > 0 ? query.take : 10;

    const where: Record<string, unknown> = {};
    if (query.status) where.status = query.status;
    if (scope.requestedBy != null) where.requestedBy = scope.requestedBy;

    const [rows, totalCount] = await this.approvalRepository.findAndCount({
      where,
      order: { requestedAt: 'DESC' },
      skip: (page - 1) * take,
      take,
    });

    return {
      list: await this.toListItems(rows, scope.includeDiagnostics),
      totalCount,
      totalPage: Math.ceil(totalCount / take),
      currentPage: page,
    };
  }

  async findOne(approvalId: string): Promise<CreditExcessApprovalEntity> {
    const approval = await this.approvalRepository.findOne({ where: { id: approvalId } });
    if (!approval) throw new NotFoundException(`approval not found id=${approvalId}`);
    return approval;
  }

  async toListItem(
    approval: CreditExcessApprovalEntity,
    includeDiagnostics: boolean,
  ): Promise<CreditExcessApprovalListItem> {
    return (await this.toListItems([approval], includeDiagnostics))[0];
  }

  private async toListItems(
    rows: CreditExcessApprovalEntity[],
    includeDiagnostics: boolean,
  ): Promise<CreditExcessApprovalListItem[]> {
    const userIds = [
      ...new Set(rows.flatMap((r) => [r.requestedBy, r.approvedBy].filter((x): x is number => x != null))),
    ];
    const users = userIds.length
      ? await this.userRepository.find({ where: { id: In(userIds) }, relations: ['company'] })
      : [];
    const userMap = new Map(users.map((u) => [u.id, u]));

    return rows.map((r) => {
      const requester = userMap.get(r.requestedBy);
      const approver = r.approvedBy != null ? userMap.get(r.approvedBy) : null;
      const base: CreditExcessApprovalListItem = {
        id: r.id,
        orderId: r.orderId,
        requesterName: requester?.personName ?? '',
        requesterCompanyName: requester?.company?.businessName ?? '',
        requestedAt: r.requestedAt.toISOString(),
        requestedAmount: r.requestedAmount,
        requestedCreditExcessAmount: r.requestedCreditExcessAmount,
        reasonText: r.reasonText,
        status: r.status,
        approverName: approver?.personName ?? null,
        rejectReason: r.rejectReason,
        userMessage: r.userMessage,
        changedFields: r.changedFields,
      };
      if (!includeDiagnostics) return base;
      return {
        ...base,
        diagnosticCode: r.diagnosticCode,
        internalReason: r.internalReason,
        processingStartedAt: r.processingStartedAt?.toISOString() ?? null,
        finishedAt: r.finishedAt?.toISOString() ?? null,
        attemptCount: r.attemptCount,
      };
    });
  }

  // ===== 생성 =====

  /**
   * PENDING row 생성. 금액·wallet·스냅샷은 **호출자(OrderModule)가 서버에서 계산한 값**만 받는다.
   * 같은 주문의 활성 요청은 생성 컬럼 unique key(`uq_credit_excess_active_order`) 로 차단된다.
   */
  async createPending(
    input: CreateCreditExcessApprovalInput,
    manager: EntityManager,
  ): Promise<CreditExcessApprovalEntity> {
    const reasonText = input.reasonText?.trim() ?? '';
    if (reasonText.length === 0) {
      throw new BadRequestException('요청 사유를 입력해 주세요.');
    }
    if (reasonText.length > 200) {
      throw new BadRequestException('요청 사유는 200자 이내여야 합니다.');
    }

    const repo = manager.getRepository(CreditExcessApprovalEntity);
    const existingActive = await repo.findOne({
      where: { orderId: input.orderId, status: In(CREDIT_EXCESS_ACTIVE_STATUSES) },
    });
    if (existingActive) {
      throw new BadRequestException(
        `이미 처리 중인 신용초과 승인 요청이 있습니다. (요청 ID=${existingActive.id}, 상태=${existingActive.status})`,
      );
    }

    try {
      return await repo.save(
        repo.create({
          ...input,
          reasonText,
          status: CreditExcessApprovalStatus.PENDING,
          attemptCount: 0,
        }),
      );
    } catch (error) {
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY') {
        throw new BadRequestException('이미 처리 중인 신용초과 승인 요청이 있습니다.');
      }
      throw error;
    }
  }

  // ===== 상태 전이 =====

  /**
   * PENDING → PROCESSING CAS 선점 (짧은 독립 트랜잭션).
   * 새 attempt/fencing token 을 발급해 이후 실행·최종화·복구 판정 기준으로 삼는다.
   */
  async claimForProcessing(
    approvalId: string,
    approverUserId: number,
    leaseMs = CreditExcessApprovalService.LEASE_MS,
  ): Promise<{ approval: CreditExcessApprovalEntity; attemptToken: string }> {
    const attemptToken = randomBytes(24).toString('hex');
    const now = new Date();
    const result = await this.approvalRepository
      .createQueryBuilder()
      .update(CreditExcessApprovalEntity)
      .set({
        status: CreditExcessApprovalStatus.PROCESSING,
        approvedBy: approverUserId,
        approvedAt: now,
        attemptToken,
        attemptCount: () => 'attempt_count + 1',
        processingStartedAt: now,
        leaseExpiresAt: new Date(now.getTime() + leaseMs),
        diagnosticCode: null,
        userMessage: null,
        changedFields: null,
        internalReason: null,
      })
      .where('id = :id AND status = :pending', { id: approvalId, pending: CreditExcessApprovalStatus.PENDING })
      .execute();

    if (result.affected !== 1) {
      // 선점 실패 = 이미 다른 요청/전이가 PENDING 을 소진했다. 최신 상태를 실어 conflict 로 던지면
      // orchestration 이 400 대신 멱등 응답으로 처리한다.
      throw new CreditExcessApprovalClaimConflictError(await this.findOne(approvalId));
    }
    return { approval: await this.findOne(approvalId), attemptToken };
  }

  /** 발송확정 트랜잭션 진입부: approval row FOR UPDATE + PROCESSING/token 검증. */
  async lockProcessing(
    manager: EntityManager,
    approvalId: string,
    attemptToken: string,
  ): Promise<CreditExcessApprovalEntity> {
    const approval = await manager
      .getRepository(CreditExcessApprovalEntity)
      .createQueryBuilder('a')
      .setLock('pessimistic_write')
      .where('a.id = :id', { id: approvalId })
      .getOne();
    if (!approval) {
      throw new NotFoundException(`approval not found id=${approvalId}`);
    }
    if (approval.status !== CreditExcessApprovalStatus.PROCESSING || approval.attemptToken !== attemptToken) {
      throw new ForbiddenException(
        `approval attempt is not current (status=${approval.status}, tokenMatched=${approval.attemptToken === attemptToken})`,
      );
    }
    return approval;
  }

  /**
   * 발송확정 트랜잭션 안에서 승인 소비 + 금액 재확인.
   * 금액이 어긋나면 재요청 필요로 분류되도록 drift 오류를 던진다.
   */
  async consume(
    approvalId: string,
    orderId: number,
    expectedCreditExcessAmount: number,
    expectedRequestedAmount: number,
    manager: EntityManager,
  ): Promise<void> {
    const approvalRepo = manager.getRepository(CreditExcessApprovalEntity);
    const approval = await approvalRepo.findOne({ where: { id: approvalId } });
    if (!approval) {
      throw new ForbiddenException(`approval not found id=${approvalId}`);
    }
    if (approval.status !== CreditExcessApprovalStatus.PROCESSING || approval.consumedAt != null) {
      throw new ForbiddenException(`approval not PROCESSING or already consumed (status=${approval.status})`);
    }
    if (approval.orderId !== orderId) {
      throw new ForbiddenException(`approval orderId mismatch (expected=${orderId}, actual=${approval.orderId})`);
    }

    const changed: string[] = [];
    if (approval.requestedCreditExcessAmount !== expectedCreditExcessAmount) changed.push('신용초과 금액');
    if (approval.requestedAmount !== expectedRequestedAmount) changed.push('결제 금액');
    if (changed.length > 0) {
      throw new CreditExcessApprovalDriftError(
        changed,
        `amount drift (excess ${approval.requestedCreditExcessAmount}→${expectedCreditExcessAmount}, ` +
          `payable ${approval.requestedAmount}→${expectedRequestedAmount})`,
      );
    }

    const result = await approvalRepo
      .createQueryBuilder()
      .update(CreditExcessApprovalEntity)
      .set({ consumedAt: () => 'NOW(6)' })
      .where('id = :id AND status = :status AND consumed_at IS NULL', {
        id: approvalId,
        status: CreditExcessApprovalStatus.PROCESSING,
      })
      .execute();
    if (result.affected !== 1) {
      throw new ForbiddenException('approval consume race (already used)');
    }
  }

  // ===== 실행 표식 =====

  /** 발송확정과 **같은 트랜잭션**에서 1회 기록. 모든 lifecycle 모드 공통. */
  async recordExecution(
    manager: EntityManager,
    input: { approvalId: string; orderId: number; attemptToken: string; lifecycleMode: string },
  ): Promise<void> {
    const repo = manager.getRepository(CreditExcessApprovalExecutionEntity);
    try {
      await repo.insert(repo.create(input));
    } catch (error) {
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY') {
        throw new ForbiddenException(`approval ${input.approvalId} already executed`);
      }
      throw error;
    }
  }

  async findExecution(
    approvalId: string,
    manager?: EntityManager,
  ): Promise<CreditExcessApprovalExecutionEntity | null> {
    const repo = manager ? manager.getRepository(CreditExcessApprovalExecutionEntity) : this.executionRepository;
    return repo.findOne({ where: { approvalId } });
  }

  // ===== 최종화 =====

  /** 실행 표식(approvalId + token) 확인 후 PROCESSING → COMPLETED. */
  async finalizeCompleted(approvalId: string, attemptToken: string, userMessage: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const execution = await this.findExecution(approvalId, manager);
      if (!execution || execution.attemptToken !== attemptToken) {
        throw new ForbiddenException(`execution marker missing for approval ${approvalId}`);
      }
      await manager
        .getRepository(CreditExcessApprovalEntity)
        .createQueryBuilder()
        .update(CreditExcessApprovalEntity)
        .set({
          status: CreditExcessApprovalStatus.COMPLETED,
          finishedAt: () => 'NOW(6)',
          leaseExpiresAt: null,
          userMessage,
          diagnosticCode: 'DISPATCH_COMPLETED',
          changedFields: null,
          internalReason: null,
        })
        .where('id = :id AND attempt_token = :token AND status = :processing', {
          id: approvalId,
          token: attemptToken,
          processing: CreditExcessApprovalStatus.PROCESSING,
        })
        .execute();
    });
  }

  /** PROCESSING → FAILED | RE_REQUEST_REQUIRED (실행 표식이 없을 때만). */
  async finalizeFailure(input: {
    approvalId: string;
    attemptToken: string;
    status: CreditExcessApprovalStatus.FAILED | CreditExcessApprovalStatus.RE_REQUEST_REQUIRED;
    diagnosticCode: string;
    userMessage: string;
    changedFields: string[] | null;
    internalReason: string;
  }): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const execution = await this.findExecution(input.approvalId, manager);
      if (execution && execution.attemptToken === input.attemptToken) {
        // 확정이 실제로 커밋된 뒤 최종화만 실패한 경우 — 실패로 덮어쓰지 않는다.
        return;
      }
      await manager
        .getRepository(CreditExcessApprovalEntity)
        .createQueryBuilder()
        .update(CreditExcessApprovalEntity)
        .set({
          status: input.status,
          finishedAt: () => 'NOW(6)',
          leaseExpiresAt: null,
          diagnosticCode: input.diagnosticCode,
          userMessage: input.userMessage,
          changedFields: input.changedFields,
          internalReason: input.internalReason.slice(0, 500),
        })
        .where('id = :id AND attempt_token = :token AND status = :processing', {
          id: input.approvalId,
          token: input.attemptToken,
          processing: CreditExcessApprovalStatus.PROCESSING,
        })
        .execute();
    });
  }

  /** 운영자 명시 거절 (PENDING 만). */
  async reject(approvalId: string, approverUserId: number, rejectReason: string): Promise<void> {
    if (!rejectReason || rejectReason.trim().length === 0) {
      throw new BadRequestException('거절 사유를 입력해 주세요.');
    }
    const result = await this.approvalRepository
      .createQueryBuilder()
      .update(CreditExcessApprovalEntity)
      .set({
        status: CreditExcessApprovalStatus.REJECTED,
        approvedBy: approverUserId,
        approvedAt: new Date(),
        finishedAt: () => 'NOW(6)',
        rejectReason: rejectReason.trim().slice(0, 200),
        diagnosticCode: 'REJECTED_BY_OPERATOR',
        userMessage: '운영자가 신용초과 발송을 거절했습니다.',
      })
      .where('id = :id AND status = :pending', { id: approvalId, pending: CreditExcessApprovalStatus.PENDING })
      .execute();

    if (result.affected !== 1) {
      const existing = await this.findOne(approvalId);
      throw new BadRequestException(`현재 상태(${existing.status})에서는 거절할 수 없습니다.`);
    }
  }

  // ===== lease 복구 =====

  /** lease 만료된 PROCESSING 후보. 만료만으로 실패 처리하지 않고 복구 작업이 표식으로 판정한다. */
  async findExpiredProcessing(limit: number): Promise<CreditExcessApprovalEntity[]> {
    return this.approvalRepository.find({
      where: { status: CreditExcessApprovalStatus.PROCESSING, leaseExpiresAt: LessThan(new Date()) },
      order: { leaseExpiresAt: 'ASC' },
      take: limit,
    });
  }

  /**
   * lease 만료 건 복구. approval row 를 FOR UPDATE 로 잠근 뒤 같은 트랜잭션에서 실행 표식을 다시 조회한다.
   *  - 동일 token 표식 존재 → COMPLETED 수렴 (재발송 금지)
   *  - 표식 없음 + PROCESSING + token 동일 → FAILED
   */
  async recoverExpired(approvalId: string): Promise<CreditExcessApprovalStatus | null> {
    return this.dataSource.transaction(async (manager) => {
      const approval = await manager
        .getRepository(CreditExcessApprovalEntity)
        .createQueryBuilder('a')
        .setLock('pessimistic_write')
        .where('a.id = :id', { id: approvalId })
        .getOne();
      if (!approval || approval.status !== CreditExcessApprovalStatus.PROCESSING) {
        return null;
      }
      if (approval.leaseExpiresAt != null && approval.leaseExpiresAt > new Date()) {
        // 재선점으로 lease 가 갱신된 건 — 건드리지 않는다.
        return null;
      }

      const execution = await this.findExecution(approvalId, manager);
      const converged = execution != null && execution.attemptToken === approval.attemptToken;
      const status = converged ? CreditExcessApprovalStatus.COMPLETED : CreditExcessApprovalStatus.FAILED;

      await manager
        .getRepository(CreditExcessApprovalEntity)
        .createQueryBuilder()
        .update(CreditExcessApprovalEntity)
        .set({
          status,
          finishedAt: () => 'NOW(6)',
          leaseExpiresAt: null,
          diagnosticCode: converged ? 'DISPATCH_COMPLETED_RECOVERED' : 'DISPATCH_LEASE_EXPIRED',
          userMessage: converged ? '발송확정이 완료되었습니다.' : '발송확정 처리가 중단되었습니다. 다시 요청해 주세요.',
          internalReason: converged
            ? `recovered by execution marker id=${execution!.id}`
            : 'lease expired without execution marker',
        })
        .where('id = :id AND status = :processing AND attempt_token = :token', {
          id: approvalId,
          processing: CreditExcessApprovalStatus.PROCESSING,
          token: approval.attemptToken,
        })
        .execute();

      return status;
    });
  }
}
