import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import { DeliveryWorkflowEntity } from '../../entity/delivery.workflow.entity';
import { MessageAttemptEntity } from '../../entity/message.attempt.entity';
import { PinIssueCommandEntity } from '../../entity/pin.issue.command.entity';
import { DeliveryWorkflowStatus } from '../../delivery/interface/delivery.workflow.status';
import { MessageAttemptStatus, MessageAttemptType } from '../../delivery/interface/message.attempt.status';
import { PinIssueCommandStatus } from '../../delivery/interface/pin.issue.command.status';
import {
  FailureCodeView,
  describeGemtekResult,
  describePartnerResponse,
} from '../../delivery/interface/failure.code.catalog';

/** 실패내역에 노출하는 workflow 종결 상태 (§8 "최종 실패와 운영 확인 대상") */
export const FAILURE_LIST_WORKFLOW_STATUSES: DeliveryWorkflowStatus[] = [
  DeliveryWorkflowStatus.FAILED_FINAL,
  DeliveryWorkflowStatus.OPS_REVIEW_REQUIRED,
  DeliveryWorkflowStatus.RESOLVED_MANUALLY_FAILED,
  DeliveryWorkflowStatus.RESOLVED_MANUALLY_REFUNDED,
];

/** 재발송(자동·수동)으로 생성되는 시도 유형 — "재발송완료" 판정 근거 */
export const RESEND_ATTEMPT_TYPES: MessageAttemptType[] = [
  MessageAttemptType.AUTO_504,
  MessageAttemptType.MANUAL_RESEND,
];

/** PIN 발급이 실패로 확정된 명령 상태 */
const PIN_FAILED_STATUSES: PinIssueCommandStatus[] = [
  PinIssueCommandStatus.TERMINAL,
  PinIssueCommandStatus.EXHAUSTED,
  PinIssueCommandStatus.UNKNOWN_DEFERRED,
];

const WORKFLOW_STATUS_KO: Record<DeliveryWorkflowStatus, string> = {
  [DeliveryWorkflowStatus.IN_PROGRESS]: '처리중',
  [DeliveryWorkflowStatus.PENDING_RECONCILE]: '결과 재조회 대기',
  [DeliveryWorkflowStatus.OPS_REVIEW_REQUIRED]: '운영 확인 필요',
  [DeliveryWorkflowStatus.COMPLETED]: '전달 완료',
  [DeliveryWorkflowStatus.FAILED_FINAL]: '최종 실패',
  [DeliveryWorkflowStatus.CANCELLED]: '주문 취소 종결',
  [DeliveryWorkflowStatus.RESOLVED_MANUALLY_SUCCESS]: '수동 성공 종결',
  [DeliveryWorkflowStatus.RESOLVED_MANUALLY_FAILED]: '수동 실패 종결',
  [DeliveryWorkflowStatus.RESOLVED_MANUALLY_REFUNDED]: '환불 종결',
};

/**
 * 컷오버 전환 건 1행의 SoT 렌더 데이터.
 * 값은 전부 `delivery_workflow` + 하위 `message_attempt`/`pin_issue_command` 에서만 나온다.
 * legacy `order_delivery.status` 는 이 구조체에 절대 섞지 않는다(§8 화면 SoT 고정).
 */
export interface DeliveryFailureSotView {
  workflowStatus: DeliveryWorkflowStatus;
  workflowStatusKo: string;
  opsReviewReason: string | null;
  /** PIN 발급 단계에서 실패 확정 (발송 실패와 구분) */
  pinIssueFailed: boolean;
  /** PIN 발급 성공 이력 존재 */
  pinIssued: boolean;
  /** 재발송(자동·수동) 시도 존재 */
  resent: boolean;
  autoResendCount: number;
  manualResendCount: number;
  channel: string | null;
  sendReason: string | null;
  failureCode: FailureCodeView | null;
  /** 마지막 확정 시각 (하위 시도 terminal 시각 → 없으면 workflow 상태 진입 시각) */
  lastResolvedAt: Date | null;
  deliveredAt: Date | null;
}

/**
 * 미전환 건의 AUTO_504 FAILED_FINAL 렌더 데이터.
 *
 * 미전환 건은 `order_delivery.status`가 COMPLETE 유지라 실패 목록에 안 걸리는데,
 * `message_attempt`에 AUTO_504 FAILED_FINAL이 있으면 504 자동 재발송이 최종 실패한 건이다.
 * 이 뷰는 해당 건을 실패 목록에 노출하기 위한 최소 렌더 데이터를 담는다.
 */
export interface Auto504FailureView {
  failureCode: FailureCodeView | null;
  resolvedAt: Date;
  autoResendCount: number;
  channel: string | null;
  sendReason: string | null;
}

/**
 * 컷오버 전환 건(`cutover_migrated_at IS NOT NULL`)의 화면 SoT 로더.
 *
 * 목록 페이지(최대 take 건)에 대해서만 호출하며, 3개 테이블을 각각 1회 조회해 N+1 을 만들지 않는다.
 */
@Injectable()
export class DeliveryFailureSotReader {
  constructor(
    @InjectRepository(DeliveryWorkflowEntity)
    private readonly workflowRepository: Repository<DeliveryWorkflowEntity>,
    @InjectRepository(MessageAttemptEntity)
    private readonly attemptRepository: Repository<MessageAttemptEntity>,
    @InjectRepository(PinIssueCommandEntity)
    private readonly pinCommandRepository: Repository<PinIssueCommandEntity>,
  ) {}

  /**
   * 주어진 orderDeliveryId 중 **전환 건만** SoT 뷰로 반환한다.
   * 미전환 건은 맵에 없으며, 호출자는 legacy 렌더로 분기한다.
   */
  async loadMigrated(orderDeliveryIds: number[]): Promise<Map<number, DeliveryFailureSotView>> {
    const views = new Map<number, DeliveryFailureSotView>();
    if (orderDeliveryIds.length === 0) {
      return views;
    }

    const workflows = await this.workflowRepository.find({
      where: { orderDeliveryId: In(orderDeliveryIds), cutoverMigratedAt: Not(IsNull()) },
    });
    if (workflows.length === 0) {
      return views;
    }

    const migratedIds = workflows.map((w) => w.orderDeliveryId);
    const [attempts, pinCommands] = await Promise.all([
      this.attemptRepository.find({
        where: { orderDeliveryId: In(migratedIds) },
        order: { orderDeliveryId: 'ASC', id: 'ASC' },
      }),
      this.pinCommandRepository.find({
        where: { orderDeliveryId: In(migratedIds) },
        order: { orderDeliveryId: 'ASC', id: 'ASC' },
      }),
    ]);

    const attemptsByDelivery = groupBy(attempts, (a) => a.orderDeliveryId);
    const pinsByDelivery = groupBy(pinCommands, (c) => c.orderDeliveryId);

    for (const workflow of workflows) {
      views.set(
        workflow.orderDeliveryId,
        this.buildView(
          workflow,
          attemptsByDelivery.get(workflow.orderDeliveryId) ?? [],
          pinsByDelivery.get(workflow.orderDeliveryId) ?? [],
        ),
      );
    }
    return views;
  }

  /**
   * 미전환 건 중 AUTO_504 FAILED_FINAL 시도가 있는 건의 렌더 데이터를 반환한다.
   *
   * DB에서 resolved_at DESC, id DESC로 정렬해 배송별 최신 실패 시도를 선택한다.
   * autoResendCount는 해당 배송의 전체 AUTO_504 시도 개수(FAILED_FINAL 외 상태 포함).
   */
  async loadNonMigratedAuto504Failed(orderDeliveryIds: number[]): Promise<Map<number, Auto504FailureView>> {
    const views = new Map<number, Auto504FailureView>();
    if (orderDeliveryIds.length === 0) {
      return views;
    }

    const attempts = await this.attemptRepository
      .createQueryBuilder('ma')
      .leftJoin(DeliveryWorkflowEntity, 'wf', 'wf.orderDeliveryId = ma.orderDeliveryId')
      .where('ma.orderDeliveryId IN (:...ids)', { ids: orderDeliveryIds })
      .andWhere('ma.attemptType = :type', { type: MessageAttemptType.AUTO_504 })
      .andWhere('(wf.cutoverMigratedAt IS NULL OR wf.id IS NULL)')
      .orderBy('ma.orderDeliveryId', 'ASC')
      .addOrderBy('ma.resolvedAt', 'DESC')
      .addOrderBy('ma.id', 'DESC')
      .getMany();

    if (attempts.length === 0) {
      return views;
    }

    const byDelivery = groupBy(attempts, (a) => a.orderDeliveryId);

    for (const [odId, odAttempts] of byDelivery) {
      const latestFailed = odAttempts.find(
        (a) => a.status === MessageAttemptStatus.FAILED_FINAL && isValidDate(a.resolvedAt),
      );
      const resolvedAt = latestFailed?.resolvedAt;
      if (!latestFailed || !isValidDate(resolvedAt)) {
        continue;
      }
      views.set(odId, {
        failureCode: describeGemtekResult(latestFailed.gemtekResult),
        resolvedAt,
        autoResendCount: odAttempts.length,
        channel: latestFailed.channel ?? null,
        sendReason: latestFailed.sendReason ?? null,
      });
    }

    return views;
  }

  private buildView(
    workflow: DeliveryWorkflowEntity,
    attempts: MessageAttemptEntity[],
    pinCommands: PinIssueCommandEntity[],
  ): DeliveryFailureSotView {
    const lastAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : null;
    const lastPinCommand = pinCommands.length > 0 ? pinCommands[pinCommands.length - 1] : null;

    const pinIssued = pinCommands.some((c) => c.status === PinIssueCommandStatus.SUCCEEDED);
    const pinIssueFailed = !pinIssued && !!lastPinCommand && PIN_FAILED_STATUSES.includes(lastPinCommand.status);

    // 실패 코드: PIN 단계 실패면 협력사 응답, 그 외에는 마지막 문자 시도의 Gemtek 결과.
    const failureCode = pinIssueFailed
      ? describePartnerResponse(lastPinCommand?.partnerResponseCode, lastPinCommand?.responseClass)
      : describeGemtekResult(lastFailedGemtekResult(attempts));

    const resolvedAt =
      lastTerminalResolvedAt(attempts) ??
      (pinCommands.length > 0 ? (pinCommands[pinCommands.length - 1].resolvedAt ?? null) : null);

    return {
      workflowStatus: workflow.workflowStatus,
      workflowStatusKo: WORKFLOW_STATUS_KO[workflow.workflowStatus] ?? workflow.workflowStatus,
      opsReviewReason: workflow.opsReviewReason ?? null,
      pinIssueFailed,
      pinIssued,
      resent: attempts.some((a) => RESEND_ATTEMPT_TYPES.includes(a.attemptType)),
      autoResendCount: attempts.filter((a) => a.attemptType === MessageAttemptType.AUTO_504).length,
      manualResendCount: attempts.filter((a) => a.attemptType === MessageAttemptType.MANUAL_RESEND).length,
      channel: lastAttempt?.channel ?? null,
      sendReason: lastAttempt?.sendReason ?? null,
      failureCode,
      lastResolvedAt: resolvedAt ?? workflow.stateEnteredAt ?? null,
      deliveredAt: workflow.deliveredAt ?? null,
    };
  }
}

/** 마지막으로 확정된 실패 결과 코드(성공 `0` 은 실패내역 표기 대상이 아니다). */
function lastFailedGemtekResult(attempts: MessageAttemptEntity[]): string | null {
  for (let i = attempts.length - 1; i >= 0; i -= 1) {
    const result = attempts[i].gemtekResult;
    if (result && result !== '0') {
      return result;
    }
  }
  return null;
}

/** 하위 시도 중 마지막 터미널 확정 시각. */
function lastTerminalResolvedAt(attempts: MessageAttemptEntity[]): Date | null {
  const terminal = attempts.filter(
    (a) =>
      a.resolvedAt &&
      [MessageAttemptStatus.SUCCEEDED, MessageAttemptStatus.FAILED_FINAL, MessageAttemptStatus.UNKNOWN].includes(
        a.status,
      ),
  );
  if (terminal.length === 0) {
    return null;
  }
  return terminal.reduce((latest, a) => (a.resolvedAt! > latest ? a.resolvedAt! : latest), terminal[0].resolvedAt!);
}

function isValidDate(value: Date | null | undefined): value is Date {
  const time = value?.getTime?.();
  return typeof time === 'number' && !Number.isNaN(time);
}

function groupBy<T>(rows: T[], key: (row: T) => number): Map<number, T[]> {
  const map = new Map<number, T[]>();
  for (const row of rows) {
    const bucket = map.get(key(row));
    if (bucket) {
      bucket.push(row);
    } else {
      map.set(key(row), [row]);
    }
  }
  return map;
}
