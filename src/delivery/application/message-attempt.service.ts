import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MessageAttemptEntity } from '../../entity/message.attempt.entity';
import { MessageAttemptChannel, MessageAttemptStatus, MessageAttemptType } from '../interface/message.attempt.status';
import { DeliveryExclusiveOp } from '../interface/delivery.workflow.status';
import { generateAttemptId } from '../domain/message.attempt.id';
import { DeliveryWorkflowSlotService } from './delivery-workflow-slot.service';
import { SmsSendOut } from '../../sms/interface/sms.send';

export interface TrackSendContext {
  orderDeliveryId: number;
  channel: MessageAttemptChannel;
  attemptType: MessageAttemptType;
  /** 발송 원인(화면 노출용). 예: `COUPON`, `ALIM_TALK_FALLBACK`, `CS_RESEND` */
  sendReason?: string;
  /** 생성 출처 op. shadow 단계 legacy 경로는 `MESSAGE_SEND` 다. */
  createdByOp?: DeliveryExclusiveOp;
  approvalId?: string | null;
  /** 테스트 발송처럼 추적 대상이 아닌 호출. true 면 상관키 없이 그대로 발송한다. */
  skipTracking?: boolean;
}

/**
 * 메시지 시도 추적 서비스 (§5.3 outbox 2단 마크).
 *
 * 발송 경로를 감싸 **외부 호출 전에** 제출 의도를 durable 커밋한다.
 *   ① `OUTBOX_READY` — 아직 Gemtek 을 호출하지 않았음이 확정. 크래시 시 재조회 없이 최초 insert 재개 가능.
 *   ② `SUBMITTING`   — 호출 시작 마크. 이 커밋 이후에만 외부 호출을 시작하며, 이후 크래시는 재조회만 허용.
 *   ③ `SUBMITTED` → `TRACKING` — `MSEQ` 확보 후 결과 조회 대상 등록.
 *
 * **shadow 단계(§10 2단계) 원칙:** 추적 실패가 실제 발송을 막지 않는다.
 * 추적 경로의 예외는 삼켜서 로그로만 남기고, 발송 함수의 예외는 기존과 동일하게 그대로 전파한다.
 * (자동 재발송·슬롯 강제는 컷오버 단계에서 활성화한다.)
 */
@Injectable()
export class MessageAttemptService {
  private readonly logger = new Logger(MessageAttemptService.name);

  constructor(
    @InjectRepository(MessageAttemptEntity)
    private readonly attemptRepository: Repository<MessageAttemptEntity>,
    private readonly slotService: DeliveryWorkflowSlotService,
  ) {}

  /**
   * 발송을 추적한다. `send` 에는 상관키(`attemptId`)를 넘겨 Gemtek `EXT_COL2` 에 기록하게 한다.
   * 추적이 불가능하면 `attemptId` 없이 발송을 그대로 수행한다(legacy 동작 보존).
   */
  async trackSend(ctx: TrackSendContext, send: (attemptId?: string) => Promise<SmsSendOut>): Promise<SmsSendOut> {
    const attempt = await this.prepare(ctx);

    try {
      const result = await send(attempt?.attemptId);
      if (attempt) {
        await this.settleSubmitted(attempt, result);
      }
      return result;
    } catch (e) {
      if (attempt) {
        // 외부 호출 시작 마크 이후의 실패는 "발급 여부 불명"이다. 재삽입하지 않고 재조회 대상으로만 남긴다.
        await this.markReconciling(attempt, e);
      }
      throw e;
    }
  }

  /**
   * 제출 의도(OUTBOX_READY)를 커밋하고 호출 시작 마크(SUBMITTING)까지 올린다.
   * 실패 시 null 을 돌려주고 발송은 추적 없이 진행한다(shadow 단계 무해성).
   */
  private async prepare(ctx: TrackSendContext): Promise<MessageAttemptEntity | null> {
    if (ctx.skipTracking) {
      return null;
    }

    try {
      const workflow = await this.slotService.ensureWorkflow(ctx.orderDeliveryId);
      const parent = await this.findChainParent(ctx);
      const attemptId = generateAttemptId();

      const attempt = await this.attemptRepository.save(
        this.attemptRepository.create({
          attemptId,
          orderDeliveryId: ctx.orderDeliveryId,
          channel: ctx.channel,
          attemptType: ctx.attemptType,
          attemptSeq: parent ? parent.attemptSeq + 1 : 1,
          retryOfAttemptId: parent?.attemptId ?? null,
          rootAttemptId: parent?.rootAttemptId ?? attemptId,
          status: MessageAttemptStatus.OUTBOX_READY,
          sendReason: ctx.sendReason ?? null,
          workflowVersion: String(workflow.workflowVersion),
          createdByOp: ctx.createdByOp ?? DeliveryExclusiveOp.MESSAGE_SEND,
          createdWorkflowVersion: String(workflow.workflowVersion),
          approvalId: ctx.approvalId ?? null,
          stateEnteredAt: new Date(),
        }),
      );

      // 외부 호출은 이 마크가 커밋된 뒤에만 시작한다(§5.3).
      const marked = await this.transition(attempt, MessageAttemptStatus.OUTBOX_READY, MessageAttemptStatus.SUBMITTING);
      if (!marked) {
        // 마크를 커밋하지 못했으면 이 시도를 추적 대상으로 주장하지 않는다(상관키 없이 발송).
        this.logger.warn(`SUBMITTING 마크 실패(추적 미적용). attemptId=${attempt.attemptId}`);
        return null;
      }

      return attempt;
    } catch (e) {
      this.logger.warn(`메시지 시도 추적 준비 실패(발송은 계속). orderDeliveryId=${ctx.orderDeliveryId}: ${e}`);
      return null;
    }
  }

  /**
   * 재발송 유형의 체인 부모를 찾는다. 최초 시도(INITIAL)는 부모가 없다.
   * 부모를 못 찾으면 체인 정보 없이 진행한다(shadow 단계에서는 알림톡 시도가 추적되지 않을 수 있다).
   */
  private async findChainParent(ctx: TrackSendContext): Promise<MessageAttemptEntity | null> {
    if (ctx.attemptType === MessageAttemptType.INITIAL) {
      return null;
    }

    return await this.attemptRepository.findOne({
      where: { orderDeliveryId: ctx.orderDeliveryId },
      order: { id: 'DESC' },
    });
  }

  /**
   * insert 결과를 반영한다. `MSEQ` 를 확보했으면 즉시 결과 조회 대상(`TRACKING`)으로 등록하고,
   * 확보하지 못했으면 `SUBMITTED` 로 남겨 재조정 대상이 되게 한다(§5.3·표 4-1).
   */
  private async settleSubmitted(attempt: MessageAttemptEntity, result: SmsSendOut): Promise<void> {
    try {
      const now = new Date();
      const mseq = result?.mseq ?? null;

      await this.attemptRepository.update(
        { attemptId: attempt.attemptId, status: MessageAttemptStatus.SUBMITTING },
        {
          status: mseq === null ? MessageAttemptStatus.SUBMITTED : MessageAttemptStatus.TRACKING,
          mseq: mseq === null ? null : String(mseq),
          receiptMonth: formatYearMonth(now),
          nextSearchMonth: formatYearMonth(now),
          stateEnteredAt: now,
        },
      );
    } catch (e) {
      this.logger.warn(`메시지 시도 추적 갱신 실패. attemptId=${attempt.attemptId}: ${e}`);
    }
  }

  /**
   * 외부 호출 실패·응답 유실. 발급 여부가 불명이므로 재조회 대상(`RECONCILING`)으로만 전환한다.
   * **재제출(blind reinsert)은 하지 않는다** — 재조회 결과 0건·복수면 `UNKNOWN` 으로 운영 종결한다(§3 다).
   */
  private async markReconciling(attempt: MessageAttemptEntity, cause: unknown): Promise<void> {
    try {
      const now = new Date();
      await this.attemptRepository.update(
        { attemptId: attempt.attemptId, status: MessageAttemptStatus.SUBMITTING },
        { status: MessageAttemptStatus.RECONCILING, receiptMonth: formatYearMonth(now), stateEnteredAt: now },
      );
    } catch (e) {
      this.logger.warn(`메시지 시도 재조정 전환 실패. attemptId=${attempt.attemptId}: ${e} (원인: ${cause})`);
    }
  }

  /** 상태 전이는 항상 현재 상태를 조건으로 건다(경쟁 시 덮어쓰지 않는다). */
  private async transition(
    attempt: MessageAttemptEntity,
    from: MessageAttemptStatus,
    to: MessageAttemptStatus,
  ): Promise<boolean> {
    const result = await this.attemptRepository.update(
      { attemptId: attempt.attemptId, status: from },
      { status: to, stateEnteredAt: new Date() },
    );

    return !!result.affected;
  }
}

/** `MSG_RESULT_yyyyMM` 파티션 탐색 커서용 월 표기(§7.3). 커넥션 타임존이 KST 고정이라 로컬 시각을 쓴다. */
export function formatYearMonth(date: Date): string {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}`;
}
