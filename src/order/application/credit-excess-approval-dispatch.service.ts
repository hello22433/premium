import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Transactional } from 'typeorm-transactional';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import {
  CreditExcessApprovalEntity,
  CreditExcessApprovalStatus,
  CREDIT_EXCESS_SNAPSHOT_VERSION,
} from '../../entity/credit.excess.approval.entity';
import { UserEntity } from '../../entity/user.entity';
import {
  CreditExcessApprovalListItem,
  CreditExcessApprovalService,
} from '../../wallet/application/credit-excess-approval.service';
import {
  CreditExcessApprovalClaimConflictError,
  CreditExcessApprovalDriftError,
} from '../../wallet/application/credit-excess-approval.errors';
import { OrderService } from './order.service';
import { CreditExcessSnapshot } from './credit-excess-snapshot';

export interface CreditExcessApprovalRequestInput {
  orderId: number;
  reasonText: string;
  pointUseAmount?: number;
  depositUseEnabled?: boolean;
  depositUseAmount?: number;
}

export interface CreditExcessApprovalExecutionResult {
  approvalId: string;
  orderId: number;
  status: CreditExcessApprovalStatus;
  userMessage: string;
  changedFields: string[] | null;
  diagnosticCode: string | null;
}

/**
 * 신용초과 승인 orchestration (OrderModule 소유).
 *
 * 운영자가 승인하면 서버가 요청자 권한으로 발송확정 command 를 실행한다. 사용자 재시도 발송확정은 없다.
 * WalletModule 은 approval 상태 저장소만 제공하며 OrderService 를 알지 않는다 (단방향 의존).
 */
@Injectable()
export class CreditExcessApprovalDispatchService {
  private readonly logger = new Logger(CreditExcessApprovalDispatchService.name);

  constructor(
    private readonly orderService: OrderService,
    private readonly approvalService: CreditExcessApprovalService,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    @InjectRepository(CreditExcessApprovalEntity)
    private readonly approvalRepository: Repository<CreditExcessApprovalEntity>,
  ) {}

  /**
   * 승인 요청 생성. 금액·wallet 은 서버가 주문 잠금 안에서 직접 계산하며 클라이언트 값은 받지 않는다.
   *
   * 스냅샷 계산(주문·billing 잠금)과 PENDING 저장을 **하나의 Order application 트랜잭션**으로 묶는다.
   * @Transactional 로 열린 CLS 트랜잭션에 buildCreditExcessApprovalRequest(@Transactional, REQUIRED)와
   * createPending(ambient manager) 이 모두 참여하므로, 잠금이 유지된 채로 요청이 저장되어 계산 시점과
   * 저장 시점 사이에 주문이 수정·확정되며 stale 요청이 생기는 창을 없앤다.
   */
  @Transactional()
  async request(user: ILoginUserInfo, input: CreditExcessApprovalRequestInput): Promise<CreditExcessApprovalListItem> {
    const computed = await this.orderService.buildCreditExcessApprovalRequest(user, {
      id: input.orderId,
      pointUseAmount: input.pointUseAmount,
      depositUseEnabled: input.depositUseEnabled,
      depositUseAmount: input.depositUseAmount,
    });

    if (computed.billingUserId !== user.id) {
      // 운영자 대행 요청도 요청자는 과금 대상(기업관리자)으로 기록한다 — 승인 실행 권한 주체가 명확해야 한다.
      this.logger.log(
        `credit excess approval requested on behalf of billing user (requester=${user.id}, billingUser=${computed.billingUserId}, orderId=${computed.orderId})`,
      );
    }

    const approval = await this.approvalService.createPending(
      {
        orderId: computed.orderId,
        walletAccountId: computed.walletAccountId,
        requestedAmount: computed.requestedAmount,
        requestedCreditExcessAmount: computed.requestedCreditExcessAmount,
        reasonText: input.reasonText,
        requestedBy: computed.billingUserId,
        snapshotVersion: CREDIT_EXCESS_SNAPSHOT_VERSION,
        snapshot: computed.snapshot as unknown as Record<string, unknown>,
      },
      // @Transactional CLS 로 잠긴 트랜잭션 매니저 — build 의 주문·billing 잠금과 같은 트랜잭션.
      this.approvalRepository.manager,
    );

    return this.approvalService.toListItem(approval, false);
  }

  /**
   * 운영자 승인 = 서버 발송확정 실행.
   *  1) PENDING → PROCESSING CAS 선점 (fencing token 발급)
   *  2) 발송확정 command 실행 (스냅샷 재검증 + 실행 표식 동일 트랜잭션 기록)
   *  3) 실행 표식 기준 COMPLETED 최종화 / 실패 분류
   */
  async approve(
    operator: ILoginUserInfo,
    approvalId: string,
    ipAddress: string,
  ): Promise<CreditExcessApprovalExecutionResult> {
    const current = await this.approvalService.findOne(approvalId);
    if (current.status !== CreditExcessApprovalStatus.PENDING) {
      // 같은 승인 ID 재호출 — 상태별 현재 결과를 멱등 반환한다.
      return this.toResult(current);
    }

    let approval: CreditExcessApprovalEntity;
    let attemptToken: string;
    try {
      ({ approval, attemptToken } = await this.approvalService.claimForProcessing(approvalId, operator.id));
    } catch (error) {
      if (error instanceof CreditExcessApprovalClaimConflictError) {
        // 동시 승인 — 다른 요청이 PENDING 을 먼저 선점했다. 패자는 400 대신 최신 상태를 멱등 반환한다.
        return this.toResult(error.current);
      }
      throw error;
    }
    const requester = await this.resolveRequesterActor(approval.requestedBy);
    const snapshot = approval.snapshot as unknown as CreditExcessSnapshot;

    try {
      await this.orderService.deliveryConfirmed(
        requester,
        {
          id: approval.orderId,
          pointUseAmount: snapshot.usage.pointUseAmount || undefined,
          depositUseEnabled: snapshot.usage.depositUseEnabled || undefined,
          depositUseAmount: snapshot.usage.depositUseAmount || undefined,
        },
        {
          approvalId: approval.id,
          attemptToken,
          snapshot,
          requesterUserId: approval.requestedBy,
          approverUserId: operator.id,
          approverEmail: operator.email,
          ipAddress,
        },
      );
    } catch (error) {
      const classified = this.classifyFailure(error);
      await this.approvalService.finalizeFailure({
        approvalId: approval.id,
        attemptToken,
        status: classified.status,
        diagnosticCode: classified.diagnosticCode,
        userMessage: classified.userMessage,
        changedFields: classified.changedFields,
        internalReason: classified.internalReason,
      });
      this.logger.warn(
        `credit excess dispatch failed approvalId=${approval.id} orderId=${approval.orderId} code=${classified.diagnosticCode} reason=${classified.internalReason}`,
      );
      return this.toResult(await this.approvalService.findOne(approval.id));
    }

    await this.approvalService.finalizeCompleted(
      approval.id,
      attemptToken,
      '발송확정이 완료되어 발송 대기 상태로 등록되었습니다.',
    );
    return this.toResult(await this.approvalService.findOne(approval.id));
  }

  async reject(
    operator: ILoginUserInfo,
    approvalId: string,
    rejectReason: string,
  ): Promise<CreditExcessApprovalListItem> {
    await this.approvalService.reject(approvalId, operator.id, rejectReason);
    return this.approvalService.toListItem(await this.approvalService.findOne(approvalId), true);
  }

  /** 운영자 조회 — 진단 코드·실행 시각·actor·내부 원인 포함 */
  async listForOperator(query: { status?: CreditExcessApprovalStatus; page?: number; take?: number }) {
    return this.approvalService.list(query, { includeDiagnostics: true });
  }

  /** 요청자 조회 — 자기 요청의 상태·사용자 메시지·변경 항목만 */
  async listForRequester(
    user: ILoginUserInfo,
    query: { status?: CreditExcessApprovalStatus; page?: number; take?: number },
  ) {
    return this.approvalService.list(query, { requestedBy: user.id, includeDiagnostics: false });
  }

  async findForRequester(user: ILoginUserInfo, approvalId: string): Promise<CreditExcessApprovalListItem> {
    const approval = await this.approvalService.findOne(approvalId);
    if (approval.requestedBy !== user.id) {
      throw new ForbiddenException('해당 승인 요청을 조회할 권한이 없습니다.');
    }
    return this.approvalService.toListItem(approval, false);
  }

  async findForOperator(approvalId: string): Promise<CreditExcessApprovalListItem> {
    return this.approvalService.toListItem(await this.approvalService.findOne(approvalId), true);
  }

  /** lease 만료 건 복구. 실행 표식이 있으면 COMPLETED 로 수렴하고, 없을 때만 FAILED 로 전이한다. */
  async recoverExpiredLeases(limit = 50): Promise<number> {
    const candidates = await this.approvalService.findExpiredProcessing(limit);
    let recovered = 0;
    for (const candidate of candidates) {
      const status = await this.approvalService.recoverExpired(candidate.id);
      if (status) {
        recovered += 1;
        this.logger.warn(`credit excess approval lease recovered approvalId=${candidate.id} status=${status}`);
      }
    }
    return recovered;
  }

  private async resolveRequesterActor(requestedBy: number): Promise<ILoginUserInfo> {
    const requester = await this.userRepository.findOne({ where: { id: requestedBy } });
    if (!requester) {
      throw new NotFoundException(`requester user not found id=${requestedBy}`);
    }
    return { id: requester.id, email: requester.email, authority: requester.authority };
  }

  private classifyFailure(error: unknown): {
    status: CreditExcessApprovalStatus.FAILED | CreditExcessApprovalStatus.RE_REQUEST_REQUIRED;
    diagnosticCode: string;
    userMessage: string;
    changedFields: string[] | null;
    internalReason: string;
  } {
    if (error instanceof CreditExcessApprovalDriftError) {
      return {
        status: CreditExcessApprovalStatus.RE_REQUEST_REQUIRED,
        diagnosticCode: 'SNAPSHOT_MISMATCH',
        userMessage: `승인 대기 중 주문 내용이 변경되어 발송하지 않았습니다. 변경 항목: ${error.changedFields.join(', ')}. 발송확정부터 다시 요청해 주세요.`,
        changedFields: error.changedFields,
        internalReason: error.internalReason,
      };
    }

    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof BadRequestException && message.includes('검토완료 상태가 아닙니다')) {
      return {
        status: CreditExcessApprovalStatus.RE_REQUEST_REQUIRED,
        diagnosticCode: 'ORDER_STATE_CHANGED',
        userMessage: '주문 상태가 변경되어 발송하지 않았습니다. 발송확정부터 다시 요청해 주세요.',
        changedFields: ['주문 상태'],
        internalReason: message,
      };
    }

    return {
      status: CreditExcessApprovalStatus.FAILED,
      diagnosticCode: error instanceof ForbiddenException ? 'DISPATCH_FORBIDDEN' : 'DISPATCH_FAILED',
      userMessage: '발송확정 처리에 실패했습니다. 운영 담당자에게 문의해 주세요.',
      changedFields: null,
      internalReason: message,
    };
  }

  private toResult(approval: CreditExcessApprovalEntity): CreditExcessApprovalExecutionResult {
    return {
      approvalId: approval.id,
      orderId: approval.orderId,
      status: approval.status,
      userMessage: approval.userMessage ?? this.defaultMessage(approval.status),
      changedFields: approval.changedFields,
      diagnosticCode: approval.diagnosticCode,
    };
  }

  private defaultMessage(status: CreditExcessApprovalStatus): string {
    switch (status) {
      case CreditExcessApprovalStatus.PENDING:
        return '운영자 승인 대기 중입니다.';
      case CreditExcessApprovalStatus.PROCESSING:
        return '발송확정을 처리하는 중입니다.';
      case CreditExcessApprovalStatus.COMPLETED:
        return '발송확정이 완료되어 발송 대기 상태로 등록되었습니다.';
      case CreditExcessApprovalStatus.REJECTED:
        return '운영자가 신용초과 발송을 거절했습니다.';
      case CreditExcessApprovalStatus.EXPIRED:
        return '승인 요청이 종료되었습니다. 발송확정부터 다시 요청해 주세요.';
      case CreditExcessApprovalStatus.RE_REQUEST_REQUIRED:
        return '주문 내용이 변경되어 재요청이 필요합니다.';
      default:
        return '발송확정 처리에 실패했습니다.';
    }
  }
}
