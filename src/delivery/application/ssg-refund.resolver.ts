import { Injectable, Logger } from '@nestjs/common';
import { PartnerCompanyExternService } from '../../partner_company_extern/application/partner.company.extern.service';
import { SsgOrphanResolveOutcome } from '../../partner_company_extern/interface/ssg.orphan.resolve';
import { SsgEventService } from '../../ssg_event/application/ssg.event.service';
import { SsgInsertState } from '../interface/ssg.insert.state';
import { SsgRefundOutcome } from '../interface/ssg.refund.resolve';
import { RefundLedgerService } from './refund-ledger.service';
import { SsgInsertStateService } from './ssg-insert-state.service';
import { RefundExecutionFencing } from './delivery-cutover-guard.service';

/**
 * SSG 행사 잔액 복구 분기 shared resolver.
 * plans/ssg-balance-refactor.md PR3.
 *
 * delivery batch refund 흐름 (refundForFail / 재발송 선차감 환불 / issue() throw catch) 과
 * external_api refund 흐름이 같이 사용한다.
 *
 * 분기 규칙 (정책표 기반):
 *   NONE        → refundForDeliveryFail() 호출 → RESTORED
 *   FAILED      → refundForDeliveryFail() 호출 → RESTORED
 *   ATTEMPTED   → orphan resolver 호출 후 확정 분기
 *                  CONFIRMED        → SKIPPED_CONFIRMED
 *                  FAILED           → refundForDeliveryFail() → RESTORED
 *                  NETWORK_UNKNOWN  → DEFERRED (ATTEMPTED 유지, 잔액 안 건드림)
 *                  SKIPPED_*        → DEFERRED (legacy/예외 상황)
 *   CONFIRMED   → SKIPPED_CONFIRMED (gross 모델 정합)
 *
 * 자사-고객사 환불(ledger claim + balance/allSettleAmount) 은 caller 영역. 이 resolver 는
 * SSG 행사 잔액만 다룬다.
 */
export interface SsgRefundResolveInput {
  orderDeliveryId: number;
  ssgEventId: number;
  refundAmount: number;
  orderId: number;
  /**
   * 멱등키로 쓸 환불 ledger row id. lease 경유(지연 가능) 호출이 claim 시점의 token-fenced id 를 전달.
   * 미전달 시 refundForDeliveryFail 이 orderDeliveryId 로 현재 row 재조회(동기 호출, race 없음).
   */
  refundLedgerId?: number;
  /**
   * lease token. 전달 시 markSsgSettled 를 token-fenced(본인 소유 lease 한정) 로 수행한다.
   * lease 가 만료/탈취된 stale holder 가 settled 를 마킹하는 것을 차단. 미전달 시 unconditional(동기 호출).
   */
  recoverToken?: string;
  /**
   * 재발송 선차감 역복원 식별자. 전달 시 이 복구는 "원래 발송 실패 환불"이 아니라
   * "재발송 새 행사 선차감의 역복원"이다 →
   *   - refundForDeliveryFail(refund_ledger_id 키) 대신 refundResendEventDeduction(resendDeductionId 키) 호출
   *     (기존 recovery_log 키 재사용 시 충돌해 실제 복원 no-op 되는 leak 차단)
   *   - markSsgSettled 호출 안 함 (원래 환불 ledger 의 settled 신호는 이 deduction 과 무관, 다음 재발송 허용 유지)
   * orphan/state 분기는 동일하게 적용된다.
   */
  resendDeductionId?: string;
  refundExecution?: RefundExecutionFencing;
}

@Injectable()
export class SsgRefundResolverService {
  private readonly logger = new Logger(SsgRefundResolverService.name);

  constructor(
    private readonly stateService: SsgInsertStateService,
    private readonly partnerCompanyExternService: PartnerCompanyExternService,
    private readonly ssgEventService: SsgEventService,
    private readonly refundLedgerService: RefundLedgerService,
  ) {}

  /**
   * SSG 행사 잔액 보정 분기 + outcome 반환.
   *
   * throw 안 함 — 내부 호출(state 조회, refundForDeliveryFail, orphan resolver) 의 실패는
   * 모두 흡수해 DEFERRED 로 반환한다. caller 는 outcome 으로 후속 흐름을 결정.
   * 신호 분리 정책 (plans/ssg-balance-refactor.md PR3 보강):
   *   - SSG 보정 실패가 고객 환불을 막지 않도록 caller try/catch 제거
   *   - 대신 ledger.ssg_balance_settled 가 false 로 남아 다음 재발송 가드 차단
   *
   * outcome 별 ledger.ssg_balance_settled 처리:
   *   - RESTORED          : markSsgSettled (true) — 보정 완료
   *   - SKIPPED_CONFIRMED : markSsgSettled (true) — 보정 불필요 (CONFIRMED)
   *   - DEFERRED          : markSsgSettled 호출 안 함 (false 유지) — 재발송 가드 차단
   */
  async resolveAndRefundIfNeeded(input: SsgRefundResolveInput): Promise<SsgRefundOutcome> {
    try {
      const state = await this.stateService.getState(input.orderDeliveryId);

      if (state === SsgInsertState.NONE || state === SsgInsertState.FAILED) {
        return this.restoreBalance(input, `state=${state}`);
      }

      if (state === SsgInsertState.CONFIRMED) {
        this.logger.log(`[SSG_REFUND] state=CONFIRMED → 행사 잔액 복구 skip. orderDeliveryId=${input.orderDeliveryId}`);
        await this.refundLedgerService.markSsgSettled(input.orderDeliveryId, input.recoverToken);
        return SsgRefundOutcome.SKIPPED_CONFIRMED;
      }

      // ATTEMPTED → orphan resolver 로 실제 등록 여부 확정
      const orphanOutcome = await this.partnerCompanyExternService.resolveSsgOrphan(input.orderDeliveryId);

      if (orphanOutcome === SsgOrphanResolveOutcome.CONFIRMED) {
        this.logger.log(
          `[SSG_REFUND] orphan resolver CONFIRMED → 행사 잔액 복구 skip. orderDeliveryId=${input.orderDeliveryId}`,
        );
        await this.refundLedgerService.markSsgSettled(input.orderDeliveryId, input.recoverToken);
        return SsgRefundOutcome.SKIPPED_CONFIRMED;
      }

      if (orphanOutcome === SsgOrphanResolveOutcome.FAILED) {
        return this.restoreBalance(input, `orphan=${orphanOutcome}`);
      }

      // NETWORK_UNKNOWN / SKIPPED_NOT_ATTEMPTED / SKIPPED_NO_CANDIDATES
      // ATTEMPTED 유지 — 잔액 건드리지 않음. 운영 알림 대상.
      this.logger.warn(
        `[SSG_REFUND] DEFERRED — orphan outcome=${orphanOutcome}, state=${state}. orderDeliveryId=${input.orderDeliveryId}. 잔액 미보정.`,
      );
      return SsgRefundOutcome.DEFERRED;
    } catch (e) {
      // state 조회/orphan resolver 자체가 throw 한 경우 — 흡수 후 DEFERRED.
      this.logger.error(
        `[SSG_REFUND] resolver 자체 예외 — DEFERRED. orderDeliveryId=${input.orderDeliveryId}, error: ${e instanceof Error ? e.message : e}`,
      );
      return SsgRefundOutcome.DEFERRED;
    }
  }

  /**
   * refundForDeliveryFail 호출 + markSsgSettled. NONE/FAILED 상태와 orphan=FAILED 양쪽에서 공유.
   * 실패 시 DEFERRED 반환.
   */
  private async restoreBalance(input: SsgRefundResolveInput, context: string): Promise<SsgRefundOutcome> {
    // 재발송 선차감 역복원 — 전용 멱등키(resendDeductionId). 원래 환불 ledger(settled) 는 미터치.
    if (input.resendDeductionId != null) {
      try {
        await this.ssgEventService.refundResendEventDeduction({
          resendDeductionId: input.resendDeductionId,
          ssgEventId: input.ssgEventId,
          orderId: input.orderId,
          amount: input.refundAmount,
          // 이 경로는 대상 발송건이 확정돼 있다 → 컷오버 판정 대상(§9 #9).
          orderDeliveryId: input.orderDeliveryId,
        });
      } catch (e) {
        this.logger.error(
          `[SSG_REFUND] refundResendEventDeduction 실패 — DEFERRED. orderDeliveryId=${input.orderDeliveryId}, context=${context}, resendDeductionId=${input.resendDeductionId}, error: ${e instanceof Error ? e.message : e}`,
        );
        return SsgRefundOutcome.DEFERRED;
      }
      return SsgRefundOutcome.RESTORED;
    }

    // 원래 발송 실패 환불 — refund_ledger_id 키 + markSsgSettled.
    try {
      const args: [number, number, number, number, number?, RefundExecutionFencing?] = [
        input.ssgEventId,
        input.orderId,
        input.refundAmount,
        input.orderDeliveryId,
        input.refundLedgerId,
      ];
      if (input.refundExecution) {
        args.push(input.refundExecution);
      }
      await this.ssgEventService.refundForDeliveryFail(...args);
    } catch (e) {
      this.logger.error(
        `[SSG_REFUND] refundForDeliveryFail 실패 — DEFERRED. orderDeliveryId=${input.orderDeliveryId}, context=${context}, error: ${e instanceof Error ? e.message : e}`,
      );
      return SsgRefundOutcome.DEFERRED;
    }
    await this.refundLedgerService.markSsgSettled(input.orderDeliveryId, input.recoverToken);
    return SsgRefundOutcome.RESTORED;
  }
}
