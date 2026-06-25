import {
  ORDER_LEVEL_SENTINEL,
  formatResource,
  buildConfirmKey,
  buildConfirmReleaseKey,
  buildFailRefundKey,
  buildDiscardRefundKey,
  buildDiscardUndoKey,
  buildSettleReleaseKey,
  buildSettleUndoKey,
  buildResendDeductKey,
  buildResendUndoKey,
} from './wallet-idempotency';
import { WalletResourceType } from './wallet-resource-type';

describe('wallet-idempotency helpers', () => {
  describe('ORDER_LEVEL_SENTINEL', () => {
    it("= 'ORDER'", () => {
      expect(ORDER_LEVEL_SENTINEL).toBe('ORDER');
    });
  });

  describe('formatResource', () => {
    it.each([
      [WalletResourceType.DEPOSIT, undefined, 'deposit'],
      [WalletResourceType.CREDIT, undefined, 'credit'],
      [WalletResourceType.CREDIT_EXCESS, undefined, 'credit_excess'],
    ])('%s → %s', (resource, pointGrantId, expected) => {
      expect(formatResource(resource as WalletResourceType, pointGrantId as number | undefined)).toBe(expected);
    });

    it('POINT 는 pointGrantId 포함', () => {
      expect(formatResource(WalletResourceType.POINT, 42)).toBe('point:42');
    });

    it('POINT 에 pointGrantId 누락 → throw', () => {
      expect(() => formatResource(WalletResourceType.POINT)).toThrow('POINT resource');
    });
  });

  describe('buildConfirmKey (plan §2 예시)', () => {
    it('confirm:1234:5678:deposit', () => {
      expect(buildConfirmKey(1234, 5678, WalletResourceType.DEPOSIT)).toBe('confirm:1234:5678:deposit');
    });

    it('confirm:1234:5678:point:42', () => {
      expect(buildConfirmKey(1234, 5678, WalletResourceType.POINT, 42)).toBe('confirm:1234:5678:point:42');
    });
  });

  describe('buildConfirmReleaseKey (v2.1 sentinel)', () => {
    it('deliveryId=null → ORDER sentinel', () => {
      expect(buildConfirmReleaseKey(1234, null, WalletResourceType.DEPOSIT)).toBe('confirm_release:1234:ORDER:deposit');
    });

    it('deliveryId 지정 → 그 값 그대로', () => {
      expect(buildConfirmReleaseKey(1234, 5678, WalletResourceType.CREDIT)).toBe('confirm_release:1234:5678:credit');
    });

    it('deliveryId=null 동일 인자 두 번 호출 = 동일 key (UNIQUE no-op 보장)', () => {
      const a = buildConfirmReleaseKey(1234, null, WalletResourceType.POINT, 7);
      const b = buildConfirmReleaseKey(1234, null, WalletResourceType.POINT, 7);
      expect(a).toBe(b);
      expect(a).toBe('confirm_release:1234:ORDER:point:7');
    });

    it('null vs undefined 모두 sentinel 로 처리', () => {
      const a = buildConfirmReleaseKey(1234, null, WalletResourceType.DEPOSIT);
      const b = buildConfirmReleaseKey(1234, undefined as unknown as null, WalletResourceType.DEPOSIT);
      expect(a).toBe(b);
    });
  });

  describe('buildFailRefundKey / buildDiscardRefundKey / buildDiscardUndoKey (repeatable, attemptId cycle)', () => {
    it('fail_refund:1234:5678:deposit:9', () => {
      expect(buildFailRefundKey(1234, 5678, WalletResourceType.DEPOSIT, 9)).toBe('fail_refund:1234:5678:deposit:9');
    });

    it('discard_refund:1234:5678:credit:9', () => {
      expect(buildDiscardRefundKey(1234, 5678, WalletResourceType.CREDIT, 9)).toBe('discard_refund:1234:5678:credit:9');
    });

    it('discard_undo:1234:5678:credit_excess:9', () => {
      expect(buildDiscardUndoKey(1234, 5678, WalletResourceType.CREDIT_EXCESS, 9)).toBe(
        'discard_undo:1234:5678:credit_excess:9',
      );
    });
  });

  describe('buildSettleReleaseKey / buildSettleUndoKey (plan §2 예시)', () => {
    it('settle_release:1234::credit:1234_1 (1차 정산)', () => {
      expect(buildSettleReleaseKey(1234, '1234_1', WalletResourceType.CREDIT)).toBe(
        'settle_release:1234::credit:1234_1',
      );
    });

    it('settle_release 재정산 = 다른 cycleId', () => {
      const c1 = buildSettleReleaseKey(1234, '1234_1', WalletResourceType.CREDIT);
      const c2 = buildSettleReleaseKey(1234, '1234_2', WalletResourceType.CREDIT);
      expect(c1).not.toBe(c2);
    });

    it('settle_undo 동일 cycleId → release 와 매칭', () => {
      expect(buildSettleUndoKey(1234, '1234_1', WalletResourceType.CREDIT)).toBe('settle_undo:1234::credit:1234_1');
    });
  });

  describe('buildResendDeductKey / buildResendUndoKey (plan §2 예시)', () => {
    it('resend_deduct:1234:5678:credit:2', () => {
      expect(buildResendDeductKey(1234, 5678, WalletResourceType.CREDIT, 2)).toBe('resend_deduct:1234:5678:credit:2');
    });

    it('resend_undo:1234:5678:credit:2', () => {
      expect(buildResendUndoKey(1234, 5678, WalletResourceType.CREDIT, 2)).toBe('resend_undo:1234:5678:credit:2');
    });
  });

  describe('determinism (동일 입력 = 동일 key)', () => {
    it('모든 helper deterministic', () => {
      const inputs = {
        orderId: 100,
        deliveryId: 200,
        cycleId: '100_3',
        attemptId: 7,
        resource: WalletResourceType.POINT,
        pointGrantId: 11,
      } as const;
      expect(buildConfirmKey(inputs.orderId, inputs.deliveryId, inputs.resource, inputs.pointGrantId)).toBe(
        buildConfirmKey(inputs.orderId, inputs.deliveryId, inputs.resource, inputs.pointGrantId),
      );
      expect(buildSettleReleaseKey(inputs.orderId, inputs.cycleId, inputs.resource, inputs.pointGrantId)).toBe(
        buildSettleReleaseKey(inputs.orderId, inputs.cycleId, inputs.resource, inputs.pointGrantId),
      );
    });
  });
});
