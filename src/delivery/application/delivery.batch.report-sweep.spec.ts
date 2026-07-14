import { DeliveryBatchService } from './delivery.batch.service';
import { IOrderDeliveryStatus } from '../interface/order.delivery.status';
import { IOrderDeliveryReportState } from '../interface/order.delivery.report.state';
import { IOrderType } from '../../order/interface/order.type';
import { OrderDeliveryCouponStatus } from '../interface/order.delivery.coupon.status';

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
    service.clearReportClaim = jest.fn().mockResolvedValue(true);
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
    /**
     * runReportFallback 은 CAS 를 **두 번** 친다.
     *  1) 변형 lease 게이트 — 폐기·환불됐거나 다른 처리 진행중인 건이면 여기서 걸러진다(D3-55 후속)
     *  2) fallback 선점(at-most-once) — 동시 sweep 차단
     * leaseAffected 로 1번, affected 로 2번을 각각 제어한다.
     */
    let qbSpy: any;
    let findOne: jest.Mock;
    /**
     * @param affected       선점(at-most-once) CAS 결과
     * @param leaseAffected  변형 lease 게이트 결과
     * @param freshRow       게이트 실패 시 원인 판정용 재조회 결과 (coupon_status / status)
     */
    const mockPreempt = (affected: number, leaseAffected = 1, freshRow: any = { id: 1, status: 'WAIT' }) => {
      const exec = jest
        .fn()
        .mockResolvedValueOnce({ affected: leaseAffected }) // 1) lease 게이트
        .mockResolvedValue({ affected }); // 2) 선점
      qbSpy = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: exec,
      };
      findOne = jest.fn().mockResolvedValue(freshRow);
      service.orderDeliveryRepository = {
        createQueryBuilder: jest.fn().mockReturnValue(qbSpy),
        update: jest.fn().mockResolvedValue({ affected: 1 }), // lease 해제
        findOne, // 게이트 실패 원인 판정
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

    /**
     * D3-55 후속 — SMS 대체발송도 "발송" 이다.
     *
     * report_owner_token 은 sweep 워커끼리의 소유권일 뿐, 폐기/외부취소/재발행과는 무관하다.
     * 알림톡 POST 는 성공했지만 수신확인이 안 된 채 재시도를 소진하는 동안(분 단위) 그 쿠폰이
     * 폐기·환불될 수 있고, 종전 코드는 그 죽은 핀을 SMS 로 다시 보낸 뒤 정산까지 했다.
     */
    describe('변형 lease / 쿠폰상태 가드 (D3-55 후속)', () => {
      it('lease 게이트 WHERE 에 변형 lease + coupon_status 술어가 있다', async () => {
        const od = buildOd();
        mockPreempt(1);

        await service.runReportFallback(od, 'tok');

        const whereSqls = qbSpy.andWhere.mock.calls.map((c: any[]) => String(c[0]));
        expect(whereSqls.some((s: string) => /mutation_claimed_at IS NULL/.test(s))).toBe(true);
        expect(whereSqls.some((s: string) => /coupon_status NOT IN/.test(s))).toBe(true);
        // 게이트는 lease 를 **획득**해야 한다 — WHERE 로 읽기만 하면 발송 구간이 무방비다
        expect(qbSpy.set.mock.calls[0][0]).toHaveProperty('mutationClaimedAt');
      });

      /**
       * ★ 게이트 실패(affected=0)의 원인은 4가지이고 처리가 다르다 (리뷰 HIGH).
       *   WHERE 는 id/token/status=WAIT/lease/coupon_status 의 AND 라 affected=0 만으로는
       *   무엇이 틀렸는지 알 수 없다. 하나로 뭉개면 **일시적 원인까지 영구 봉인**된다.
       *
       *   status=WAIT + report_state=UNCONFIRMED 는 이 코드베이스에서 **아무도 집지 못하는 상태**다:
       *     reportSweep         → report_state=PENDING 요구
       *     claimWaitDeliveries → report_state IS NULL 요구
       *     CS reSend           → status IN (COMPLETE/FAIL/...) 요구
       *     발송실패내역 재발송  → status IN (FAIL/FAIL_SMS) 요구
       *   자동·수동 어떤 회수 경로도 없는 영구 정체다.
       */
      it('원인=폐기·환불 → SMS 미발송 + 정산 미수행 + recovery 미진입 (유일하게 정당한 봉인)', async () => {
        const od = buildOd();
        mockPreempt(1, 0, { id: 1, status: 'WAIT', couponStatus: OrderDeliveryCouponStatus.REFUND_CANCEL });
        const recoverSpy = jest.spyOn(service, 'recoverStuckFallback').mockResolvedValue(undefined);

        await service.runReportFallback(od, 'tok');

        expect(service.csResendAsMms).not.toHaveBeenCalled();
        expect(service.markOrderTerminalAndSettle).not.toHaveBeenCalled();
        // recovery 로 보내면 FAIL 확정·환불로 이어질 수 있다 — 폐기가 이미 환불했으면 이중 환불
        expect(recoverSpy).not.toHaveBeenCalled();
        expect(service.refundForFail).not.toHaveBeenCalled();
        expect(od.reportState).toBe(IOrderDeliveryReportState.UNCONFIRMED);

        // ★ status 는 **건드리지 않는다** (4차 조준 리뷰 CRITICAL x2 — 한때 여기서 CANCEL 로
        //   전이했다가 철회했다). 두 가지 이유로 틀렸다:
        //
        //   ① 정산을 열어주지 못한다. isOrderAllDeliveriesTerminal 의 터미널 집합은
        //      [COMPLETE, COMPLETE_SMS, FAIL, FAIL_SMS] 로 **CANCEL 을 포함하지 않는다** —
        //      CANCEL 은 WAIT 과 똑같이 비터미널이라 얻는 게 없다.
        //   ② **lease 를 못 잡은 상태에서 남의 행에 터미널을 쓰는 짓**이다. 이 분기의 진입 조건이
        //      곧 leaseGate.affected=0(= 남이 이 행의 운명을 결정 중)이다. 그 액터가 재발행이면
        //      이후 reverseDiscard 가 coupon_status 만 NOT_USED 로 되돌려(status 는 안 만진다)
        //      **status=CANCEL + coupon_status=NOT_USED** 가 남는다 — 고객은 알림톡으로 살아있는
        //      쿠폰을 받았는데 DB·CS 는 "취소됨" 이다.
        //
        //   남는 행(WAIT + coupon CANCEL + UNCONFIRMED)은 무해하다: 쿠폰은 이미 죽고 환불도
        //   끝났으므로 아무도 할 일이 없고, 모든 발송 경로가 coupon_status 가드로 배제한다.
        expect(od.status).toBe(IOrderDeliveryStatus.WAIT);
        expect(service.persistReportState).toHaveBeenCalled();
      });

      it('원인=일시적(변형 lease 활성) → PENDING 유지 + 다음 tick 재시도 (영구 봉인 금지)', async () => {
        const od = buildOd();
        // 폐기 아님 + 아직 WAIT — 즉 폐기/재발행/CS재발송이 lease 를 쥐고 있는 일시적 상황
        mockPreempt(1, 0, { id: 1, status: 'WAIT', couponStatus: OrderDeliveryCouponStatus.NOT_USED });
        const recoverSpy = jest.spyOn(service, 'recoverStuckFallback').mockResolvedValue(undefined);

        await service.runReportFallback(od, 'tok');

        expect(service.csResendAsMms).not.toHaveBeenCalled();
        expect(recoverSpy).not.toHaveBeenCalled();
        // ★ UNCONFIRMED 로 닫으면 아무도 못 집는 영구 고아가 된다
        expect(od.reportState).toBe(IOrderDeliveryReportState.PENDING);
        expect(od.reportNextDueAt.getTime()).toBeGreaterThan(Date.now()); // 다음 tick 으로 미룸
        expect(service.persistReportState).toHaveBeenCalled();
      });

      it('원인=이미 터미널(status != WAIT) → recoverStuckFallback (종전 동작 유지)', async () => {
        const od = buildOd();
        mockPreempt(1, 0, { id: 1, status: IOrderDeliveryStatus.COMPLETE_SMS, couponStatus: null });
        const recoverSpy = jest.spyOn(service, 'recoverStuckFallback').mockResolvedValue(undefined);

        await service.runReportFallback(od, 'tok');

        expect(recoverSpy).toHaveBeenCalledWith(od, 'tok');
        expect(service.csResendAsMms).not.toHaveBeenCalled();
      });

      it('정상 경로: 변형 lease 를 자기 토큰으로 해제한다', async () => {
        const od = buildOd();
        mockPreempt(1);
        service.csResendAsMms.mockResolvedValue(undefined);

        await service.runReportFallback(od, 'tok');

        const release = service.orderDeliveryRepository.update.mock.calls.find(
          (c: any[]) => c[1] && c[1].mutationClaimedAt === null,
        );
        expect(release).toBeDefined();
        expect(release[0]).toEqual({ id: od.id, mutationClaimedAt: expect.any(Date) });
      });
    });

    it('HIGH-1) 선점 성공 + SMS 성공이지만 persist 소유권 상실(false) → 이력정정/정산 미수행', async () => {
      const od = buildOd();
      mockPreempt(1);
      service.csResendAsMms.mockResolvedValue(undefined);
      service.persistReportState = jest.fn().mockResolvedValue(false); // lease 회전으로 소유권 상실

      await service.runReportFallback(od, 'tok');

      expect(service.csResendAsMms).toHaveBeenCalledWith(od.id); // 선점은 성공
      expect(service.correctSendHistory).not.toHaveBeenCalled();
      expect(service.markOrderTerminalAndSettle).not.toHaveBeenCalled();
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
      expect(service.clearReportClaim).toHaveBeenCalledWith(od, 'tok'); // 터미널 행은 clearReportClaim 사용
      expect(service.persistReportState).not.toHaveBeenCalled();
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

  describe('reconcileSettlementDrift (완료/정산 drift 복구)', () => {
    // completion / settlement 두 쿼리는 각각 별도 repository.createQueryBuilder 를 1회씩 사용
    const qbReturning = (rows: any[]) => ({
      createQueryBuilder: jest.fn().mockReturnValue({
        innerJoin: jest.fn().mockReturnThis(),
        leftJoin: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        having: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue(rows),
      }),
    });

    const bind = () => {
      service.reconcileSettlementDrift = (DeliveryBatchService.prototype as any).reconcileSettlementDrift;
    };

    it('HIGH-2) completion drift: 전건 터미널 + DELIVERY_CONFIRMED → 완료전이 + 정산 + settlement 재정산', async () => {
      bind();
      service.orderDeliveryRepository = qbReturning([{ id: 100 }]); // completion drift 후보
      service.orderRepository = qbReturning([{ id: 200 }]); // settlement drift 후보
      service.isOrderAllDeliveriesTerminal = jest.fn().mockResolvedValue(true);
      service.transitionOrderToComplete = jest.fn().mockResolvedValue(true);
      service.settleIfDrift = jest.fn().mockResolvedValue(undefined);
      service.autoSettlePrePaymentOrders = jest.fn().mockResolvedValue(undefined);

      await service.reconcileSettlementDrift();

      expect(service.transitionOrderToComplete).toHaveBeenCalledWith(100);
      expect(service.settleIfDrift).toHaveBeenCalledWith(100);
      expect(service.autoSettlePrePaymentOrders).toHaveBeenCalledWith([200]);
    });

    it('completion drift 후보지만 비-전건터미널 → 전이/정산 skip', async () => {
      bind();
      service.orderDeliveryRepository = qbReturning([{ id: 100 }]);
      service.orderRepository = qbReturning([]);
      service.isOrderAllDeliveriesTerminal = jest.fn().mockResolvedValue(false);
      service.transitionOrderToComplete = jest.fn();
      service.settleIfDrift = jest.fn();
      service.autoSettlePrePaymentOrders = jest.fn();

      await service.reconcileSettlementDrift();

      expect(service.transitionOrderToComplete).not.toHaveBeenCalled();
      expect(service.settleIfDrift).not.toHaveBeenCalled();
      expect(service.autoSettlePrePaymentOrders).not.toHaveBeenCalled();
    });
  });
});
