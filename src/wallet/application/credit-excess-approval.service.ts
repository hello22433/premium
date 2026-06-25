import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull, Repository } from 'typeorm';
import { CreditExcessApprovalEntity, CreditExcessApprovalStatus } from '../../entity/credit.excess.approval.entity';
import { OrderEntity } from '../../entity/order.entity';
import { UserEntity } from '../../entity/user.entity';
import { WalletAccountResolverService } from './wallet-account-resolver.service';

/**
 * 신용초과 4단계 워크플로 (Open Decision 2).
 *  Step A — 기업관리자 발송확정 호출 → message='credit_excess' preview (DB 차감 없음, 별 method 아님)
 *  Step B — request(): reasonText 포함 PENDING row 생성
 *  Step C — approve / reject: 운영관리자 별도 API 호출
 *  Step D — consume(): 발송확정 트랜잭션 안에서 조건부 UPDATE (consumed_at 채움, affectedRows=1 검증)
 */
@Injectable()
export class CreditExcessApprovalService {
  constructor(
    @InjectRepository(CreditExcessApprovalEntity)
    private readonly approvalRepository: Repository<CreditExcessApprovalEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly walletAccountResolver: WalletAccountResolverService,
  ) {}

  /**
   * Step C — 사전 승인 목록 조회 (운영자). status 기본 PENDING. 요청자/승인자 이름·회사명은 user 조인.
   */
  async list(query: { status?: CreditExcessApprovalStatus; page?: number; take?: number }): Promise<{
    list: Array<{
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
    }>;
    totalCount: number;
    totalPage: number;
    currentPage: number;
  }> {
    const status = query.status ?? CreditExcessApprovalStatus.PENDING;
    const page = query.page && query.page > 0 ? query.page : 1;
    const take = query.take && query.take > 0 ? query.take : 10;

    const [rows, totalCount] = await this.approvalRepository.findAndCount({
      where: { status },
      order: { requestedAt: 'DESC' },
      skip: (page - 1) * take,
      take,
    });

    // 요청자/승인자 user 조인 (이름 + 회사명). 현재 entity 는 user_id 만 보유.
    const userIds = [
      ...new Set(rows.flatMap((r) => [r.requestedBy, r.approvedBy].filter((x): x is number => x != null))),
    ];
    const users = userIds.length
      ? await this.userRepository.find({ where: { id: In(userIds) }, relations: ['company'] })
      : [];
    const userMap = new Map(users.map((u) => [u.id, u]));

    const list = rows.map((r) => {
      const requester = userMap.get(r.requestedBy);
      const approver = r.approvedBy != null ? userMap.get(r.approvedBy) : null;
      return {
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
      };
    });

    return {
      list,
      totalCount,
      totalPage: Math.ceil(totalCount / take),
      currentPage: page,
    };
  }

  /**
   * Step B — 사전 승인 요청.
   *
   * 검증:
   *  - reasonText 1~200자.
   *  - orderId 존재 + requestedBy 가 order 의 billing user (clientUserId ?? userId).
   *  - walletAccountId 가 order 의 wallet 과 일치.
   *  - requestedCreditExcessAmount > 0, requestedAmount >= requestedCreditExcessAmount.
   *  - 동일 orderId 의 PENDING/APPROVED 미사용 row 가 이미 있으면 거절 (중복 요청 차단).
   */
  async request(input: {
    orderId: number;
    walletAccountId: string;
    requestedAmount: number;
    requestedCreditExcessAmount: number;
    reasonText: string;
    requestedBy: number;
  }): Promise<CreditExcessApprovalEntity> {
    if (!input.reasonText || input.reasonText.trim().length === 0) {
      throw new BadRequestException('reasonText required');
    }
    if (input.reasonText.length > 200) {
      throw new BadRequestException('reasonText must be <= 200 chars');
    }
    if (input.requestedCreditExcessAmount <= 0) {
      throw new BadRequestException('requestedCreditExcessAmount must be > 0');
    }
    if (input.requestedAmount < input.requestedCreditExcessAmount) {
      throw new BadRequestException(
        `requestedAmount(${input.requestedAmount}) must be >= requestedCreditExcessAmount(${input.requestedCreditExcessAmount})`,
      );
    }

    // 단일 트랜잭션 + order FOR UPDATE 로 동시 요청 직렬화 (race 차단).
    // app-level findOne + save 만으로는 같은 orderId 의 active approval 2건 동시 INSERT 가능 →
    // order row lock 으로 같은 주문의 request() 호출 순차 처리.
    return this.dataSource.transaction(async (manager) => {
      const order = await manager
        .getRepository(OrderEntity)
        .createQueryBuilder('o')
        .setLock('pessimistic_write')
        .where('o.id = :id', { id: input.orderId })
        .getOne();
      if (!order) {
        throw new NotFoundException(`order not found id=${input.orderId}`);
      }
      const billingUserId = order.clientUserId ?? order.userId;
      if (billingUserId !== input.requestedBy) {
        throw new ForbiddenException(
          `requester(${input.requestedBy}) is not the billing user(${billingUserId}) of order ${input.orderId}`,
        );
      }
      const wallet = await this.walletAccountResolver.resolveForOrder(order, manager);
      if (String(wallet.id) !== String(input.walletAccountId)) {
        throw new ForbiddenException(
          `walletAccountId mismatch (expected=${wallet.id}, actual=${input.walletAccountId}) for order ${input.orderId}`,
        );
      }

      // 동일 order 미사용 active approval 중복 차단 — order lock 보유 상태에서 단일 조회.
      const existingActive = await manager.getRepository(CreditExcessApprovalEntity).findOne({
        where: [
          { orderId: input.orderId, status: CreditExcessApprovalStatus.PENDING, consumedAt: IsNull() },
          { orderId: input.orderId, status: CreditExcessApprovalStatus.APPROVED, consumedAt: IsNull() },
        ],
      });
      if (existingActive) {
        throw new BadRequestException(
          `order ${input.orderId} already has active approval (id=${existingActive.id}, status=${existingActive.status})`,
        );
      }

      return manager.getRepository(CreditExcessApprovalEntity).save({
        ...input,
        status: CreditExcessApprovalStatus.PENDING,
      });
    });
  }

  /**
   * Step C - approve / reject: 조건부 UPDATE (status=PENDING) + affectedRows=1 검증.
   * findOne + save 패턴은 approve/reject 동시 호출 시 race — 둘 다 PENDING 을 읽고 마지막 save 가
   * 최종 상태 덮어쓰는 lost-update 가능. WHERE 절에 status=PENDING 조건 포함 + affectedRows
   * 확인으로 race-free 보장.
   */
  async approve(approvalId: string, approverUserId: number): Promise<CreditExcessApprovalEntity> {
    const now = new Date();
    const result = await this.approvalRepository
      .createQueryBuilder()
      .update(CreditExcessApprovalEntity)
      .set({
        status: CreditExcessApprovalStatus.APPROVED,
        approvedBy: approverUserId,
        approvedAt: now,
      })
      .where('id = :id AND status = :pending', {
        id: approvalId,
        pending: CreditExcessApprovalStatus.PENDING,
      })
      .execute();

    if (result.affected !== 1) {
      // 실패 원인 구분 — not found vs status 이미 변경됨
      const existing = await this.approvalRepository.findOne({ where: { id: approvalId } });
      if (!existing) {
        throw new NotFoundException(`approval not found id=${approvalId}`);
      }
      throw new BadRequestException(`approval status is ${existing.status}, cannot approve`);
    }

    return (await this.approvalRepository.findOne({ where: { id: approvalId } }))!;
  }

  async reject(approvalId: string, approverUserId: number, rejectReason: string): Promise<CreditExcessApprovalEntity> {
    if (!rejectReason || rejectReason.trim().length === 0) {
      throw new BadRequestException('rejectReason required');
    }
    const now = new Date();
    const result = await this.approvalRepository
      .createQueryBuilder()
      .update(CreditExcessApprovalEntity)
      .set({
        status: CreditExcessApprovalStatus.REJECTED,
        approvedBy: approverUserId,
        approvedAt: now,
        rejectReason,
      })
      .where('id = :id AND status = :pending', {
        id: approvalId,
        pending: CreditExcessApprovalStatus.PENDING,
      })
      .execute();

    if (result.affected !== 1) {
      const existing = await this.approvalRepository.findOne({ where: { id: approvalId } });
      if (!existing) {
        throw new NotFoundException(`approval not found id=${approvalId}`);
      }
      throw new BadRequestException(`approval status is ${existing.status}, cannot reject`);
    }

    return (await this.approvalRepository.findOne({ where: { id: approvalId } }))!;
  }

  /**
   * 발송확정 트랜잭션 안에서 호출. 조건부 UPDATE로 1회만 사용 보장.
   * affectedRows=0 (이미 사용됐거나 status 변동) → ForbiddenException.
   *
   * externalManager 지정 시 그 트랜잭션 안에서 실행 (same-tx 보장).
   * 미지정 시 default repository (별 트랜잭션) — PR1 caller 없음, PR2 이후 발송확정 hook 에서 manager 주입 필수.
   */
  async consume(
    approvalId: string,
    orderId: number,
    expectedCreditExcessAmount: number,
    expectedRequestedAmount: number,
    externalManager?: EntityManager,
  ): Promise<void> {
    const approvalRepo = externalManager
      ? externalManager.getRepository(CreditExcessApprovalEntity)
      : this.approvalRepository;

    const approval = await approvalRepo.findOne({
      where: { id: approvalId, status: CreditExcessApprovalStatus.APPROVED, consumedAt: IsNull() },
    });
    if (!approval) {
      throw new ForbiddenException('approval not APPROVED or already consumed');
    }
    if (approval.orderId !== orderId) {
      throw new ForbiddenException(`approval orderId mismatch (expected=${orderId}, actual=${approval.orderId})`);
    }
    if (approval.requestedCreditExcessAmount !== expectedCreditExcessAmount) {
      throw new ForbiddenException(
        `approval amount mismatch (expected=${expectedCreditExcessAmount}, actual=${approval.requestedCreditExcessAmount})`,
      );
    }
    // 총 청구액 대조 — 포인트/예치금 입력으로 확정 시점 총액이 승인 시점과 달라지면 차단.
    // requestedCreditExcessAmount 만으로는 "승인받은 분배 ≠ 확정 분배" (총액 변화) 를 못 잡음.
    if (approval.requestedAmount !== expectedRequestedAmount) {
      throw new ForbiddenException(
        `approval requestedAmount mismatch (expected=${expectedRequestedAmount}, actual=${approval.requestedAmount})`,
      );
    }

    const result = await approvalRepo
      .createQueryBuilder()
      .update(CreditExcessApprovalEntity)
      .set({ consumedAt: () => 'NOW(6)' })
      .where('id = :id AND status = :status AND consumed_at IS NULL', {
        id: approvalId,
        status: CreditExcessApprovalStatus.APPROVED,
      })
      .execute();
    if (result.affected !== 1) {
      throw new ForbiddenException('approval consume race (already used)');
    }
  }

  private async findOrThrow(approvalId: string): Promise<CreditExcessApprovalEntity> {
    const approval = await this.approvalRepository.findOne({ where: { id: approvalId } });
    if (!approval) throw new NotFoundException(`approval not found id=${approvalId}`);
    return approval;
  }
}
