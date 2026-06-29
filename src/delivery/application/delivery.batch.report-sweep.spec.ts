import { DeliveryBatchService } from './delivery.batch.service';
import { IOrderDeliveryStatus } from '../interface/order.delivery.status';
import { IOrderDeliveryReportState } from '../interface/order.delivery.report.state';
import { IOrderType } from '../../order/interface/order.type';

/**
 * Phase 4/5 회귀: 알림톡 비동기 수신확인(reportSweep) + 자동 재발송 1회 + 정산 단일헬퍼.
 * Object.create 패턴으로 DI 없이 신규 메서드 단위 검증 (matrix a/b/c/d/n/o/p/q/h2 일부).
 */
describe('DeliveryBatchService — reportSweep / settlement (async alimtalk)', () => {
  let service: any;

  const buildOd = (over: Record<string, any> = {}) => ({
    id: 1,
    status: IOrderDeliveryStatus.WAIT,
    reportState: IOrderDeliveryReportState.PENDING,
    reportAttemptCount: 0,
    reportFallbackAttemptCount: 0,
    reportDeadlineAt: new Date(Date.now() + 120_000),
    reportNextDueAt: new Date(Date.now() - 1),
    alimTalkMsgKey: 'MSG-1',
    actualSendAt: new Date(),
    failedAt: null,
    orderProductMapping: { order: { id: 100, type: IOrderType.GENERAL } },
    ...over,
  });

  beforeEach(() => {
    service = Object.create(DeliveryBatchService.prototype);
    service.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    service.persistReportState = jest.fn().mockResolvedValue(true);
    service.correctSendHistory = jest.fn().mockResolvedValue(undefined);
    service.markOrderTerminalAndSettle = jest.fn().mockResolvedValue(undefined);
    service.markSendSuccess = jest.fn((od: any, s: IOrderDeliveryStatus) => {
      od.status = s;
    });
    service.markSendFail = jest.fn((od: any, s: IOrderDeliveryStatus) => {
      od.status = s;
    });
    service.refundForFail = jest.fn().mockResolvedValue(undefined);
    service.shouldHoldRefundForFail = jest.fn().mockResolvedValue(true); // 비-SSG 기본 보류
    service.csResendAsMms = jest.fn().mockResolvedValue(undefined);
    service.deliveryAlimTalk = { inquiryReport: jest.fn() };
  });

  describe('processOneReport', () => {
    it('a) 도착확정(10000) → COMPLETE + 정산 + 이력 성공정정', async () => {
      const od = buildOd();
      service.deliveryAlimTalk.inquiryReport.mockResolvedValue({ success: true, reportCode: '10000', data: {} });

      await service.processOneReport(od, 'tok');

      expect(od.status).toBe(IOrderDeliveryStatus.COMPLETE);
      expect(od.reportState).toBe(IOrderDeliveryReportState.CONFIRMED);
      expect(service.correctSendHistory).toHaveBeenCalledWith(od.id, true, expect.anything());
      expect(service.markOrderTerminalAndSettle).toHaveBeenCalledWith(100);
      expect(service.csResendAsMms).not.toHaveBeenCalled();
    });

    it('미확정 & attempt<2 & 마감 전 → 재시도(다음 due 갱신, PENDING 유지, fallback 미진입)', async () => {
      const od = buildOd({ reportAttemptCount: 0 });
      service.deliveryAlimTalk.inquiryReport.mockResolvedValue({ success: false, error: 'no report yet' });
      const fallbackSpy = jest.spyOn(service, 'runReportFallback').mockResolvedValue(undefined);

      await service.processOneReport(od, 'tok');

      expect(od.reportState).toBe(IOrderDeliveryReportState.PENDING);
      expect(od.reportAttemptCount).toBe(1);
      expect(fallbackSpy).not.toHaveBeenCalled();
      expect(service.persistReportState).toHaveBeenCalled();
    });

    it('미확정 & attempt 소진(2) → runReportFallback 진입', async () => {
      const od = buildOd({ reportAttemptCount: 1 }); // ++ → 2
      service.deliveryAlimTalk.inquiryReport.mockResolvedValue({ success: false });
      const fallbackSpy = jest.spyOn(service, 'runReportFallback').mockResolvedValue(undefined);

      await service.processOneReport(od, 'tok');

      expect(fallbackSpy).toHaveBeenCalledWith(od, 'tok');
    });

    it('마감 초과 → 즉시 runReportFallback', async () => {
      const od = buildOd({ reportAttemptCount: 0, reportDeadlineAt: new Date(Date.now() - 1) });
      service.deliveryAlimTalk.inquiryReport.mockResolvedValue({ success: false });
      const fallbackSpy = jest.spyOn(service, 'runReportFallback').mockResolvedValue(undefined);

      await service.processOneReport(od, 'tok');

      expect(fallbackSpy).toHaveBeenCalledWith(od, 'tok');
    });
  });

  describe('runReportFallback (자동 재발송 1회, at-most-once)', () => {
    const mockPreempt = (affected: number) => {
      const exec = jest.fn().mockResolvedValue({ affected });
      service.orderDeliveryRepository = {
        createQueryBuilder: jest.fn().mockReturnValue({
          update: jest.fn().mockReturnThis(),
          set: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          execute: exec,
        }),
      };
      return exec;
    };

    it('b) 선점(affected=1) + SMS 성공 → COMPLETE_SMS + 정산', async () => {
      const od = buildOd();
      mockPreempt(1);
      service.csResendAsMms.mockResolvedValue(undefined);

      await service.runReportFallback(od, 'tok');

      expect(service.csResendAsMms).toHaveBeenCalledWith(od.id);
      expect(od.status).toBe(IOrderDeliveryStatus.COMPLETE_SMS);
      expect(od.reportState).toBe(IOrderDeliveryReportState.UNCONFIRMED);
      expect(service.markOrderTerminalAndSettle).toHaveBeenCalledWith(100);
      expect(service.refundForFail).not.toHaveBeenCalled();
    });

    it('c) 선점(affected=1) + SMS 실패 → FAIL + 환불판정(비-SSG 보류=환불X)', async () => {
      const od = buildOd();
      mockPreempt(1);
      service.csResendAsMms.mockRejectedValue(new Error('SMS fail'));

      await service.runReportFallback(od, 'tok');

      expect(od.status).toBe(IOrderDeliveryStatus.FAIL);
      expect(service.shouldHoldRefundForFail).toHaveBeenCalled();
      expect(service.refundForFail).not.toHaveBeenCalled(); // 비-SSG 최초실패 보류
      expect(service.markOrderTerminalAndSettle).toHaveBeenCalledWith(100);
    });

    it('c-2) SMS 실패 + shouldHold=false → refundForFail 호출', async () => {
      const od = buildOd();
      mockPreempt(1);
      service.csResendAsMms.mockRejectedValue(new Error('SMS fail'));
      service.shouldHoldRefundForFail.mockResolvedValue(false);

      await service.runReportFallback(od, 'tok');

      expect(service.refundForFail).toHaveBeenCalledWith(od);
    });

    it('q) 선점 실패(affected=0, 동시 sweep) → recoverStuckFallback, SMS 미발송', async () => {
      const od = buildOd();
      mockPreempt(0);
      const recoverSpy = jest.spyOn(service, 'recoverStuckFallback').mockResolvedValue(undefined);

      await service.runReportFallback(od, 'tok');

      expect(recoverSpy).toHaveBeenCalledWith(od, 'tok');
      expect(service.csResendAsMms).not.toHaveBeenCalled();
    });
  });

  describe('recoverStuckFallback (n: 선점 후 크래시 회수)', () => {
    it('비터미널 stuck → 재전송 없이 FAIL 확정(CS 회수)', async () => {
      const od = buildOd({ status: IOrderDeliveryStatus.WAIT });
      const finalizeSpy = jest.spyOn(service, 'finalizeReportFail').mockResolvedValue(undefined);

      await service.recoverStuckFallback(od, 'tok');

      expect(od.reportState).toBe(IOrderDeliveryReportState.UNCONFIRMED);
      expect(finalizeSpy).toHaveBeenCalledWith(od, 'tok');
      expect(service.csResendAsMms).not.toHaveBeenCalled();
    });

    it('이미 COMPLETE_SMS 종결됨 → claim 정리만, 환불/재전송 없음', async () => {
      const od = buildOd({ status: IOrderDeliveryStatus.COMPLETE_SMS });
      const finalizeSpy = jest.spyOn(service, 'finalizeReportFail').mockResolvedValue(undefined);

      await service.recoverStuckFallback(od, 'tok');

      expect(od.reportState).toBe(IOrderDeliveryReportState.CONFIRMED);
      expect(finalizeSpy).not.toHaveBeenCalled();
      expect(service.persistReportState).toHaveBeenCalled();
    });
  });

  describe('markOrderTerminalAndSettle (정산 단일헬퍼 + drift)', () => {
    it('전건 터미널 아니면 전이/정산 보류', async () => {
      service.markOrderTerminalAndSettle = (DeliveryBatchService.prototype as any).markOrderTerminalAndSettle;
      service.isOrderAllDeliveriesTerminal = jest.fn().mockResolvedValue(false);
      service.transitionOrderToComplete = jest.fn();
      service.settleIfDrift = jest.fn();

      await service.markOrderTerminalAndSettle(100);

      expect(service.transitionOrderToComplete).not.toHaveBeenCalled();
      expect(service.settleIfDrift).not.toHaveBeenCalled();
    });

    it('o) 전건 터미널 → 전이 + 정산. transition affected=0(이미 COMPLETE)이어도 settleIfDrift 실행(drift 복구)', async () => {
      service.markOrderTerminalAndSettle = (DeliveryBatchService.prototype as any).markOrderTerminalAndSettle;
      service.isOrderAllDeliveriesTerminal = jest.fn().mockResolvedValue(true);
      service.transitionOrderToComplete = jest.fn().mockResolvedValue(false); // affected=0
      service.settleIfDrift = jest.fn().mockResolvedValue(undefined);

      await service.markOrderTerminalAndSettle(100);

      expect(service.transitionOrderToComplete).toHaveBeenCalledWith(100);
      expect(service.settleIfDrift).toHaveBeenCalledWith(100); // affected 무관 멱등 호출
    });
  });
});
