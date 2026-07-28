import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MessageAttemptEntity } from '../../entity/message.attempt.entity';
import { MessageAttemptChannel, MessageAttemptStatus, MessageAttemptType } from '../interface/message.attempt.status';
import { DeliveryExclusiveOp, LEGACY_SEND_OP, TrackingCreatedByOp } from '../interface/delivery.workflow.status';
import { generateAttemptId } from '../domain/message.attempt.id';
import { DeliverySlot, DeliveryWorkflowSlotService, SlotApprovalBinding } from './delivery-workflow-slot.service';
import { SmsSendOut } from '../../sms/interface/sms.send';

export interface TrackSendContext {
  orderDeliveryId: number;
  channel: MessageAttemptChannel;
  attemptType: MessageAttemptType;
  /** 발송 원인(화면 노출용). 예: `COUPON`, `ALIM_TALK_FALLBACK`, `CS_RESEND` */
  sendReason?: string;
  /**
   * **컷오버 전환 건**에서 점유할 배타 op (§6.1 표 2-1). 필수다 — 기본값을 두면 수동 재발송이
   * `MESSAGE_SEND` 로 잘못 점유돼 허용 상태(`FAILED_FINAL`/`OPS_REVIEW_REQUIRED`)를 벗어나고,
   * 생성 출처(`created_by_op`)도 자동 op 로 오기록돼 `§10` 불변식 ②/②-b 가 오분류한다.
   * 미전환 건에서는 슬롯을 잡지 않으므로 감사 기록 용도로만 쓰인다.
   */
  slotOp: DeliveryExclusiveOp;
  /**
   * DUAL op 의 승인 바인딩(§6.2). 전환 건에서 `OPS_REVIEW_REQUIRED` 를 점유하려면 반드시 필요하다.
   * 없으면 승인 불요 상태(`MANUAL_RESEND` = `FAILED_FINAL` 등)에서만 점유가 성립한다.
   */
  approval?: SlotApprovalBinding;
  /** 테스트 발송처럼 추적 대상이 아닌 호출. true 면 상관키 없이 그대로 발송한다. */
  skipTracking?: boolean;
}

/** 전환 여부에 따른 실행 게이트. 전환 건만 Level A 슬롯을 점유한다. */
interface TrackingGate {
  /** 컷오버 전환 건(`cutover_migrated_at IS NOT NULL`) 여부 */
  cutover: boolean;
  workflowVersion: string;
  slot: DeliverySlot | null;
}

/**
 * 메시지 시도 추적 서비스 (§5.3 outbox 2단 마크 + §9 컷오버 게이트).
 *
 * 발송 경로를 감싸 **외부 호출 전에** 제출 의도를 durable 커밋한다.
 *   ① `OUTBOX_READY` — 아직 Gemtek 을 호출하지 않았음이 확정. 크래시 시 재조회 없이 최초 insert 재개 가능.
 *   ② `SUBMITTING`   — 호출 시작 마크. 이 커밋 이후에만 외부 호출을 시작하며, 이후 크래시는 재조회만 허용.
 *   ③ `SUBMITTED` → `TRACKING` — `MSEQ` 확보 후 결과 조회 대상 등록.
 *
 * **동시성 모델은 전환 마크로 갈린다(§9 단일 동시성 모델 원칙).**
 * - **미전환 건**: 기존 `claimedAt`/`mutationClaimedAt` 이 유일한 동시성 모델이다. 여기에 Level A 슬롯을
 *   덧붙이면 서로를 모르는 두 모델이 공존해 오히려 이중 발송이 뚫린다. 따라서 슬롯을 잡지 않고
 *   **관찰만** 하며(추적 실패는 삼켜 발송을 막지 않는다), 생성 출처는 `LEGACY_SEND` 로 기록한다.
 * - **전환 건**(`cutover_migrated_at IS NOT NULL`): legacy 진입을 거부하고 **Level A 슬롯 점유를 강제**한다.
 *   슬롯을 얻지 못하면 발송 자체를 수행하지 않으며(fail-closed), 추적 행 생성 실패도 삼키지 않는다.
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
   * SMS/MMS 발송을 추적한다. `send` 에는 상관키(`attemptId`)를 넘겨 Gemtek `EXT_COL2` 에 기록하게 한다.
   * 미전환 건에서 추적이 불가능하면 `attemptId` 없이 발송을 그대로 수행한다(legacy 동작 보존).
   */
  async trackSend(ctx: TrackSendContext, send: (attemptId?: string) => Promise<SmsSendOut>): Promise<SmsSendOut> {
    if (ctx.skipTracking) {
      return await send(undefined);
    }

    // 슬롯을 잡은 뒤에는 어떤 경로로 빠져나가도 반드시 해제한다(추적 행 생성 실패 포함).
    const gate = await this.openGate(ctx);
    try {
      const attempt = await this.prepare(ctx, gate);

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
    } finally {
      await this.closeGate(gate);
    }
  }

  /**
   * **사전 생성된 attempt(`OUTBOX_READY`)** 로 발송을 실행한다 (§5.3 재발송 두 행 변경의 원자성).
   *
   * `dueResend`(§6.3) 는 "원 시도 `RETRIED` 전이 + 신규 시도 생성"을 **하나의 트랜잭션**으로 커밋한 뒤
   * 외부 호출만 남긴다. 그 신규 행은 `trackSend` 처럼 여기서 생성하지 않으므로, 이 메서드는
   * 상태 마크(`SUBMITTING`)와 결과 반영만 수행한다.
   *
   * `OUTBOX_READY → SUBMITTING` CAS 가 실패하면(다른 worker 선점·이미 진행) 외부 호출 없이
   * false 를 돌려준다 — 같은 attempt 로 두 번 insert 하는 경로를 상태 전이가 차단한다.
   */
  async trackPreparedSend(
    attempt: MessageAttemptEntity,
    send: (attemptId: string) => Promise<SmsSendOut>,
  ): Promise<boolean> {
    // 외부 호출은 이 마크가 커밋된 뒤에만 시작한다(§5.3 outbox 2단 마크).
    const marked = await this.transition(attempt, MessageAttemptStatus.OUTBOX_READY, MessageAttemptStatus.SUBMITTING);
    if (!marked) {
      this.logger.warn(`SUBMITTING 마크 실패(선점·진행 중) — 발송하지 않는다. attemptId=${attempt.attemptId}`);
      return false;
    }

    try {
      const result = await send(attempt.attemptId);
      await this.settleSubmitted(attempt, result);
      return true;
    } catch (e) {
      // 외부 호출 시작 마크 이후의 실패는 "발급 여부 불명"이다. 재삽입하지 않고 재조회 대상으로만 남긴다.
      await this.markReconciling(attempt, e);
      throw e;
    }
  }

  /**
   * 알림톡 발송을 추적한다(§3 나 — 현행 알림톡 흐름은 유지하되 시도는 기록한다).
   *
   * 알림톡은 Gemtek 큐를 쓰지 않아 상관키·`MSEQ` 가 없다. 그럼에도 시도를 남기는 이유는
   * **SMS 폴백이 체인 부모를 갖게 하기 위함**이다. 부모가 없으면 `CHANNEL_FALLBACK` 의
   * "원 attempt 당 1회" unique 키가 NULL 이 되어 제약이 무력화된다(§5.3 표).
   *
   * `accepted` 판정은 호출자(legacy)가 내리는 값을 그대로 기록한다. 접수 성공은 최종 전달이 아니므로
   * `TRACKING`(미확정)으로 두고, 실패는 legacy 가 폴백을 실행하는 확정 실패이므로 `FAILED_FINAL` 로 둔다.
   * 전송 예외의 "발송 여부 불명" 세분화(`RECONCILING`/`UNKNOWN`)는 알림톡 report sweep 연동과 함께
   * 컷오버 슬라이스에서 도입한다.
   */
  async trackAlimTalk<T>(
    ctx: Omit<TrackSendContext, 'channel'>,
    send: () => Promise<T>,
    accepted: (result: T) => boolean,
  ): Promise<T> {
    if (ctx.skipTracking) {
      return await send();
    }

    const alimTalkCtx: TrackSendContext = { ...ctx, channel: MessageAttemptChannel.ALIM_TALK };
    const gate = await this.openGate(alimTalkCtx);
    try {
      const attempt = await this.prepare(alimTalkCtx, gate);

      try {
        const result = await send();
        if (attempt) {
          await this.resolveAlimTalk(attempt, accepted(result));
        }
        return result;
      } catch (e) {
        if (attempt) {
          await this.resolveAlimTalk(attempt, false);
        }
        throw e;
      }
    } finally {
      await this.closeGate(gate);
    }
  }

  /**
   * 전환 여부를 판정하고, 전환 건이면 Level A 슬롯을 점유한다.
   * 슬롯을 얻지 못한 전환 건은 발송을 수행하지 않는다(§9 전환 마크 기반 legacy 진입 거부).
   */
  private async openGate(ctx: TrackSendContext): Promise<TrackingGate> {
    let workflow: Awaited<ReturnType<DeliveryWorkflowSlotService['ensureWorkflow']>>;
    try {
      workflow = await this.slotService.ensureWorkflow(ctx.orderDeliveryId);
    } catch (e) {
      // 전환 여부조차 알 수 없는 상태다. 미전환이 대다수인 shadow 단계에서는 발송을 막지 않는다.
      this.logger.warn(`workflow 조회 실패(추적 미적용). orderDeliveryId=${ctx.orderDeliveryId}: ${e}`);
      return { cutover: false, workflowVersion: '0', slot: null };
    }

    if (!workflow.cutoverMigratedAt) {
      return { cutover: false, workflowVersion: String(workflow.workflowVersion), slot: null };
    }

    const acquired = await this.slotService.acquire({
      orderDeliveryId: ctx.orderDeliveryId,
      op: ctx.slotOp,
      approval: ctx.approval,
    });
    if (!acquired.acquired) {
      // 전환 건은 legacy 경로로 처리하지 않는다(§9 전환 마크 기반 진입 거부).
      // DUAL 이 필요한 상태(OPS_REVIEW_REQUIRED)면 승인 바인딩을 갖춘 경로로만 실행할 수 있다.
      throw new ConflictException({
        code: acquired.code,
        requiresDualApproval: acquired.requiresDualApproval ?? false,
        message:
          `전환 건은 배타 슬롯 없이 발송할 수 없습니다. ` +
          `(orderDeliveryId: ${ctx.orderDeliveryId}, op: ${ctx.slotOp}, ` +
          `workflowStatus: ${acquired.workflowStatus ?? 'UNKNOWN'})`,
      });
    }

    return { cutover: true, workflowVersion: acquired.slot.workflowVersion, slot: acquired.slot };
  }

  /** 점유한 슬롯을 fencing 조건과 함께 해제한다. 이미 회수됐으면 타인의 슬롯을 건드리지 않는다. */
  private async closeGate(gate: TrackingGate): Promise<void> {
    if (!gate.slot) {
      return;
    }

    try {
      await this.slotService.release(gate.slot);
    } catch (e) {
      this.logger.error(`배타 슬롯 해제 실패. orderDeliveryId=${gate.slot.orderDeliveryId}: ${e}`);
    }
  }

  /**
   * 제출 의도(OUTBOX_READY)를 커밋하고 호출 시작 마크(SUBMITTING)까지 올린다.
   *
   * 미전환 건은 실패해도 null 을 돌려주고 발송을 계속한다(shadow 무해성). **전환 건은 fail-closed** —
   * 추적 행이 곧 durable outbox 이므로 그것 없이 외부 호출을 시작하지 않는다.
   */
  private async prepare(ctx: TrackSendContext, gate: TrackingGate): Promise<MessageAttemptEntity | null> {
    try {
      const parent = await this.findChainParent(ctx);
      const attemptId = generateAttemptId();
      const createdByOp: TrackingCreatedByOp = gate.cutover ? ctx.slotOp : LEGACY_SEND_OP;

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
          ownerToken: gate.slot?.ownerToken ?? null,
          workflowVersion: gate.workflowVersion,
          createdByOp,
          createdWorkflowVersion: gate.workflowVersion,
          approvalId: ctx.approval?.approvalId ?? null,
          stateEnteredAt: new Date(),
        }),
      );

      // 외부 호출은 이 마크가 커밋된 뒤에만 시작한다(§5.3).
      const marked = await this.transition(attempt, MessageAttemptStatus.OUTBOX_READY, MessageAttemptStatus.SUBMITTING);
      if (!marked) {
        throw new Error(`SUBMITTING 마크 실패. attemptId=${attempt.attemptId}`);
      }

      return attempt;
    } catch (e) {
      if (gate.cutover) {
        // 전환 건은 추적 없이 발송하지 않는다(이중 발송·미추적 발송 차단).
        throw e;
      }
      this.logger.warn(`메시지 시도 추적 준비 실패(발송은 계속). orderDeliveryId=${ctx.orderDeliveryId}: ${e}`);
      return null;
    }
  }

  /**
   * 재발송·폴백 유형의 체인 부모를 찾는다. 최초 시도(INITIAL)는 부모가 없다.
   *
   * 알림톡도 추적하므로 SMS 폴백은 같은 사이클의 알림톡 시도를 부모로 잡는다
   * (부모가 있어야 `CHANNEL_FALLBACK` 1회 unique 가 실제로 강제된다, §5.3).
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

  /** 알림톡 접수 결과를 반영한다(접수 성공=미확정 `TRACKING`, 실패=폴백을 유발한 확정 실패). */
  private async resolveAlimTalk(attempt: MessageAttemptEntity, accepted: boolean): Promise<void> {
    try {
      const now = new Date();
      await this.attemptRepository.update(
        { attemptId: attempt.attemptId, status: MessageAttemptStatus.SUBMITTING },
        {
          status: accepted ? MessageAttemptStatus.TRACKING : MessageAttemptStatus.FAILED_FINAL,
          resolvedAt: accepted ? null : now,
          stateEnteredAt: now,
        },
      );
    } catch (e) {
      this.logger.warn(`알림톡 시도 추적 갱신 실패. attemptId=${attempt.attemptId}: ${e}`);
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
