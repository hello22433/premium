import { Injectable, Logger } from '@nestjs/common';
import { PartnerCompanyExternService } from '../../partner_company_extern/application/partner.company.extern.service';
import { SsgOrphanResolveOutcome } from '../../partner_company_extern/interface/ssg.orphan.resolve';
import { SsgEventService } from '../../ssg_event/application/ssg.event.service';
import { SsgInsertState } from '../interface/ssg.insert.state';
import { SsgRefundOutcome } from '../interface/ssg.refund.resolve';
import { RefundLedgerService } from './refund-ledger.service';
import { SsgInsertStateService } from './ssg-insert-state.service';

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
        try {
          await this.ssgEventService.refundForDeliveryFail(input.ssgEventId, input.orderId, input.refundAmount);
        } catch (e) {
          this.logger.error(
            `[SSG_REFUND] refundForDeliveryFail 실패 — DEFERRED. orderDeliveryId=${input.orderDeliveryId}, state=${state}, error: ${e instanceof Error ? e.message : e}`,
          );
          return SsgRefundOutcome.DEFERRED;
        }
        await this.refundLedgerService.markSsgSettled(input.orderDeliveryId);
        return SsgRefundOutcome.RESTORED;
      }

      if (state === SsgInsertState.CONFIRMED) {
        this.logger.log(
          `[SSG_REFUND] state=CONFIRMED → 행사 잔액 복구 skip. orderDeliveryId=${input.orderDeliveryId}`,
        );
        await this.refundLedgerService.markSsgSettled(input.orderDeliveryId);
        return SsgRefundOutcome.SKIPPED_CONFIRMED;
      }

      // ATTEMPTED → orphan resolver 로 실제 등록 여부 확정
      const orphanOutcome = await this.partnerCompanyExternService.resolveSsgOrphan(input.orderDeliveryId);

      if (orphanOutcome === SsgOrphanResolveOutcome.CONFIRMED) {
        this.logger.log(
          `[SSG_REFUND] orphan resolver CONFIRMED → 행사 잔액 복구 skip. orderDeliveryId=${input.orderDeliveryId}`,
        );
        await this.refundLedgerService.markSsgSettled(input.orderDeliveryId);
        return SsgRefundOutcome.SKIPPED_CONFIRMED;
      }

      if (orphanOutcome === SsgOrphanResolveOutcome.FAILED) {
        try {
          await this.ssgEventService.refundForDeliveryFail(input.ssgEventId, input.orderId, input.refundAmount);
        } catch (e) {
          this.logger.error(
            `[SSG_REFUND] refundForDeliveryFail 실패 (orphan FAILED 이후) — DEFERRED. orderDeliveryId=${input.orderDeliveryId}, error: ${e instanceof Error ? e.message : e}`,
          );
          return SsgRefundOutcome.DEFERRED;
        }
        await this.refundLedgerService.markSsgSettled(input.orderDeliveryId);
        return SsgRefundOutcome.RESTORED;
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
}
