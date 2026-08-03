import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PinIssueCommandEntity } from '../../entity/pin.issue.command.entity';
import { LEGACY_SEND_OP } from '../interface/delivery.workflow.status';
import { PartnerResponseClass, PinIssueCommandStatus } from '../interface/pin.issue.command.status';

/**
 * 협력사 PIN 발급 명령 기록 (§5.2 `pin_issue_command` **최소 배선**).
 *
 * 구현 범위는 `plans/2026-08-03-pin-issue-retry-wiring.md` §4.3 에 고정돼 있다. 이번에 쓰는 것은
 * `status`·`attempt_count`·`response_class`·`partner_response_code`·`request_key` 뿐이다.
 * Level B 3중 fencing(`owner_token`/`generation`/`workflow_version`)과 `dual_approval` 연계
 * (`approval_id`)는 컷오버 작업 소관이라 여기서 채우지 않는다.
 *
 * ⚠ **`created_by_op` 는 항상 `LEGACY_SEND` 다.** 컷오버 전 legacy 발송 경로가 만드는 행이므로
 * `PIN_ISSUE`/`RETRY` 로 찍으면 §10 불변식 ②-c(승인 없는 발급 탐지)가 **legacy 정상 동작을
 * 위반으로 집계**한다. `message_attempt` 쪽이 같은 이유로 같은 규약을 쓴다
 * (`message-resend-executor.service.ts:291-292`, `message-attempt.service.ts:314`).
 *
 * 부수 효과로 DDL 의 `initial_issue_key`(`created_by_op='PIN_ISSUE'` 일 때만 값이 생기는 생성 컬럼)가
 * 항상 NULL 이 되어 `uk_pin_issue_command_initial` 유니크 제약에도 걸리지 않는다.
 *
 * **이 서비스는 기록 전용이다.** 실패해도 발송 흐름을 막지 않는다 — 추적 기록을 남기려다
 * 실제 발송을 죽이면 본말전도다. 모든 메서드가 예외를 삼키고 로그만 남긴다.
 */
@Injectable()
export class PinIssueCommandService {
  private readonly logger = new Logger(PinIssueCommandService.name);

  constructor(
    @InjectRepository(PinIssueCommandEntity)
    private readonly repository: Repository<PinIssueCommandEntity>,
  ) {}

  /**
   * 발급 시도를 기록한다. 같은 `order_delivery` 의 기존 명령이 있으면 `attempt_count` 를 올리고
   * `RETRYING`(재시도 실행 중)으로, 없으면 `STARTED` 로 새 행을 만든다.
   *
   * 2-pass 배치에서 pass 1 은 새 행(`STARTED`, count=1), pass 2 는 같은 행 갱신
   * (`RETRYING`, count=2)이 된다. 계약 §2 의 "1회 자동 재시도" 상한이 count=2 다.
   */
  async recordAttempt(params: {
    orderDeliveryId: number;
    partnerType: string;
    requestKey: string | null;
  }): Promise<void> {
    try {
      const existing = await this.findLatest(params.orderDeliveryId);

      if (!existing) {
        await this.repository.insert({
          orderDeliveryId: params.orderDeliveryId,
          partnerType: params.partnerType,
          requestKey: params.requestKey,
          status: PinIssueCommandStatus.STARTED,
          attemptCount: 1,
          createdByOp: LEGACY_SEND_OP,
          createdWorkflowVersion: '0',
          stateEnteredAt: new Date(),
        });
        return;
      }

      await this.repository.update(
        { id: existing.id },
        {
          status: PinIssueCommandStatus.RETRYING,
          attemptCount: existing.attemptCount + 1,
          requestKey: params.requestKey ?? existing.requestKey,
          stateEnteredAt: new Date(),
        },
      );
    } catch (e) {
      this.logger.error(`[PIN_CMD] 시도 기록 실패(무시하고 발송 계속). odId=${params.orderDeliveryId}: ${e}`);
    }
  }

  /** 발급 성공 확정. */
  async markSucceeded(orderDeliveryId: number): Promise<void> {
    await this.settle(orderDeliveryId, PinIssueCommandStatus.SUCCEEDED, PartnerResponseClass.SUCCESS, null);
  }

  /**
   * 재시도 예약(§5.4 `RETRY_PENDING`). 2-pass 배치의 pass 1 이 조회 불가로 보류한 상태다.
   *
   * `next_attempt_at` 은 채우지 않는다 — 재시도가 **같은 배치 사이클의 pass 2** 에서 즉시
   * 일어나므로 예약 시각이라는 개념이 없다(계약 §2: "30~60분 고정 대기는 사용하지 않는다").
   * 별도 대기 배치로 바뀌면 그때 채운다.
   */
  async markRetryPending(orderDeliveryId: number, reason: string | null): Promise<void> {
    await this.settle(orderDeliveryId, PinIssueCommandStatus.RETRY_PENDING, PartnerResponseClass.RETRYABLE, reason);
  }

  /** 재시도까지 소진하고 실패 확정(§5.4 `EXHAUSTED`). */
  async markExhausted(orderDeliveryId: number, reason: string | null): Promise<void> {
    await this.settle(orderDeliveryId, PinIssueCommandStatus.EXHAUSTED, PartnerResponseClass.RETRYABLE, reason);
  }

  /**
   * 재시도 무의미한 확정 실패(§5.4 `STARTED → TERMINAL`).
   *
   * SSG 는 §9 `PARTNER_RESPONSE_*` 코드표 대상이 아니라(계약 610행) 응답만으로 버킷을 확정할 수
   * 없다. 여기서 `TERMINAL` 은 "협력사가 terminal 코드를 줬다" 가 아니라 **"재시도 대상으로
   * 분류되지 않았다"** 는 뜻이다 — 이번 배선이 `RETRYABLE` 로 인정하는 것은 조회 실패
   * (`SsgTryError`)뿐이다(§7 결정 ②).
   */
  async markTerminal(orderDeliveryId: number, reason: string | null): Promise<void> {
    await this.settle(orderDeliveryId, PinIssueCommandStatus.TERMINAL, PartnerResponseClass.TERMINAL, reason);
  }

  private async settle(
    orderDeliveryId: number,
    status: PinIssueCommandStatus,
    responseClass: PartnerResponseClass,
    reason: string | null,
  ): Promise<void> {
    try {
      const existing = await this.findLatest(orderDeliveryId);
      if (!existing) {
        return;
      }

      const terminal =
        status === PinIssueCommandStatus.SUCCEEDED ||
        status === PinIssueCommandStatus.EXHAUSTED ||
        status === PinIssueCommandStatus.TERMINAL;

      await this.repository.update(
        { id: existing.id },
        {
          status,
          responseClass,
          // 원본 응답코드 컬럼은 32자다. SSG 는 코드계가 없어 사유 문자열이 오므로 잘라 넣는다.
          partnerResponseCode: reason ? reason.slice(0, 32) : null,
          stateEnteredAt: new Date(),
          resolvedAt: terminal ? new Date() : null,
        },
      );
    } catch (e) {
      this.logger.error(`[PIN_CMD] 상태 기록 실패(무시하고 발송 계속). odId=${orderDeliveryId}, status=${status}: ${e}`);
    }
  }

  /**
   * 같은 `order_delivery` 의 최신 명령. `created_by_op='LEGACY_SEND'` 라 유니크 제약이 없어
   * 이론상 여러 행이 생길 수 있으므로 항상 최신 1건을 대상으로 한다.
   */
  private async findLatest(orderDeliveryId: number): Promise<PinIssueCommandEntity | null> {
    return await this.repository.findOne({ where: { orderDeliveryId }, order: { id: 'DESC' } });
  }
}
