import { OrderReceiveService } from './order.receive.service';
import { ChoicePostSendStatus } from '../../delivery/interface/choice.post.send.status';
import { CHOICE_POST_SEND_STALE_MS } from './choice.reentry.const';
import { IProductType } from '../../product/interface/product.type';
import { IOrderSendMethod } from '../../order/interface/order.send.method';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { OrderDeliveryEmailCouponStatus } from '../../delivery/interface/order.delivery.email.coupon.status';

/**
 * 초이스 재진입 차단 — 순수 판정 로직 단위 테스트.
 * CAS/외부발송 흐름은 통합 빌드/수기 검증으로 별도 확인한다.
 */
describe('OrderReceiveService 재진입 차단 판정', () => {
  // 순수 메서드만 호출하므로 의존성은 주입하지 않는다.
  const service = new OrderReceiveService(
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
  );

  type OdOverrides = {
    type?: IProductType;
    deliveryMethod?: IOrderSendMethod;
    status?: IOrderDeliveryStatus;
    choicePostSendStatus?: ChoicePostSendStatus | null;
    choicePostSendClaimedAt?: Date | null;
    choiceSelectProductId?: number | null;
    barCode?: string | null;
    emailCouponStatus?: OrderDeliveryEmailCouponStatus | null;
  };

  const fresh = () => new Date();
  const stale = () => new Date(Date.now() - CHOICE_POST_SEND_STALE_MS - 1000);

  const makeOd = (o: OdOverrides = {}): any => ({
    deliveryMethod: o.deliveryMethod ?? IOrderSendMethod.MMS,
    status: o.status ?? IOrderDeliveryStatus.COMPLETE,
    choicePostSendStatus: o.choicePostSendStatus ?? null,
    choicePostSendClaimedAt: o.choicePostSendClaimedAt ?? null,
    choiceSelectProductId: o.choiceSelectProductId ?? null,
    barCode: o.barCode ?? null,
    emailCouponStatus: o.emailCouponStatus ?? null,
    orderProductMapping: { product: { type: o.type ?? IProductType.CHOICE } },
  });

  const blockChoiceReentry = (od: any): boolean => (service as any).computeBlockChoiceReentry(od);
  const requiresChoicePostSend = (od: any): boolean => (service as any).requiresChoicePostSend(od);
  const isLegacy = (od: any): boolean => (service as any).isLegacyChoiceReentryBlocked(od);

  describe('computeBlockChoiceReentry', () => {
    it('MMS(기본) + SENT → 미차단 (MMS도 재열람 허용)', () => {
      expect(blockChoiceReentry(makeOd({ choicePostSendStatus: ChoicePostSendStatus.SENT }))).toBe(false);
    });

    it('MMS(기본) + 활성 SENDING → 미차단', () => {
      expect(
        blockChoiceReentry(
          makeOd({ choicePostSendStatus: ChoicePostSendStatus.SENDING, choicePostSendClaimedAt: fresh() }),
        ),
      ).toBe(false);
    });

    it('stale SENDING → 차단 안 함(재선점 허용)', () => {
      expect(
        blockChoiceReentry(
          makeOd({ choicePostSendStatus: ChoicePostSendStatus.SENDING, choicePostSendClaimedAt: stale() }),
        ),
      ).toBe(false);
    });

    it('FAILED → 차단 안 함(재시도 허용)', () => {
      expect(blockChoiceReentry(makeOd({ choicePostSendStatus: ChoicePostSendStatus.FAILED, barCode: 'B' }))).toBe(
        false,
      );
    });

    it('NOT_REQUIRED → 차단 안 함', () => {
      expect(blockChoiceReentry(makeOd({ choicePostSendStatus: ChoicePostSendStatus.NOT_REQUIRED }))).toBe(false);
    });

    it('EMAIL 경로는 항상 차단 안 함', () => {
      expect(
        blockChoiceReentry(
          makeOd({ deliveryMethod: IOrderSendMethod.EMAIL, choicePostSendStatus: ChoicePostSendStatus.SENT }),
        ),
      ).toBe(false);
    });

    it('CHOICE 아님 → 차단 안 함', () => {
      expect(
        blockChoiceReentry(makeOd({ type: IProductType.GENERAL, choicePostSendStatus: ChoicePostSendStatus.SENT })),
      ).toBe(false);
    });

    it('legacy MMS(선택+barCode) → 미차단 (MMS도 재열람 허용)', () => {
      expect(
        blockChoiceReentry(
          makeOd({
            choicePostSendStatus: null,
            choiceSelectProductId: 7,
            barCode: 'B',
            deliveryMethod: IOrderSendMethod.MMS,
            status: IOrderDeliveryStatus.COMPLETE,
          }),
        ),
      ).toBe(false);
    });

    it('legacy ALIM_TALK+COMPLETE → fallback 미차단', () => {
      expect(
        blockChoiceReentry(
          makeOd({
            choicePostSendStatus: null,
            choiceSelectProductId: 7,
            barCode: 'B',
            deliveryMethod: IOrderSendMethod.ALIM_TALK,
            status: IOrderDeliveryStatus.COMPLETE,
          }),
        ),
      ).toBe(false);
    });

    it('ALIM_TALK 문자폴백(COMPLETE_SMS) + SENT → 미차단 (알림톡 웹링크로 재열람 가능)', () => {
      expect(
        blockChoiceReentry(
          makeOd({
            deliveryMethod: IOrderSendMethod.ALIM_TALK,
            status: IOrderDeliveryStatus.COMPLETE_SMS,
            choicePostSendStatus: ChoicePostSendStatus.SENT,
          }),
        ),
      ).toBe(false);
    });

    it('legacy ALIM_TALK 문자폴백(COMPLETE_SMS) → 미차단', () => {
      expect(
        blockChoiceReentry(
          makeOd({
            choicePostSendStatus: null,
            choiceSelectProductId: 7,
            barCode: 'B',
            deliveryMethod: IOrderSendMethod.ALIM_TALK,
            status: IOrderDeliveryStatus.COMPLETE_SMS,
          }),
        ),
      ).toBe(false);
    });

    it('MMS + COMPLETE + SENT → 미차단 (MMS 재진입 차단 해제)', () => {
      expect(
        blockChoiceReentry(
          makeOd({
            deliveryMethod: IOrderSendMethod.MMS,
            status: IOrderDeliveryStatus.COMPLETE,
            choicePostSendStatus: ChoicePostSendStatus.SENT,
          }),
        ),
      ).toBe(false);
    });

    it('legacy 선택 전(choiceSelectProductId=null) → 미차단', () => {
      expect(blockChoiceReentry(makeOd({ choicePostSendStatus: null, choiceSelectProductId: null }))).toBe(false);
    });
  });

  describe('requiresChoicePostSend', () => {
    it('barCode 있고 SMS/COMPLETE → 필요', () => {
      expect(requiresChoicePostSend(makeOd({ barCode: 'B', deliveryMethod: IOrderSendMethod.MMS }))).toBe(true);
    });

    it('ALIM_TALK+COMPLETE → 불필요', () => {
      expect(
        requiresChoicePostSend(
          makeOd({ barCode: 'B', deliveryMethod: IOrderSendMethod.ALIM_TALK, status: IOrderDeliveryStatus.COMPLETE }),
        ),
      ).toBe(false);
    });

    it('ALIM_TALK+COMPLETE_SMS → 필요', () => {
      expect(
        requiresChoicePostSend(
          makeOd({
            barCode: 'B',
            deliveryMethod: IOrderSendMethod.ALIM_TALK,
            status: IOrderDeliveryStatus.COMPLETE_SMS,
          }),
        ),
      ).toBe(true);
    });

    it('barCode 없음 → 불필요', () => {
      expect(requiresChoicePostSend(makeOd({ barCode: null }))).toBe(false);
    });

    it('EMAIL → 불필요', () => {
      expect(requiresChoicePostSend(makeOd({ barCode: 'B', deliveryMethod: IOrderSendMethod.EMAIL }))).toBe(false);
    });
  });

  describe('isLegacyChoiceReentryBlocked', () => {
    it('null 상태 + 선택 + barCode + 비EMAIL + 비(ALIM_TALK+COMPLETE) → true', () => {
      expect(isLegacy(makeOd({ choicePostSendStatus: null, choiceSelectProductId: 7, barCode: 'B' }))).toBe(true);
    });

    it('상태가 채워진 신규 행 → false', () => {
      expect(
        isLegacy(makeOd({ choicePostSendStatus: ChoicePostSendStatus.SENT, choiceSelectProductId: 7, barCode: 'B' })),
      ).toBe(false);
    });
  });
});
