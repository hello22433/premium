import { computePayloadHash, computeAssertionHash, computeEvidenceHash } from './proposal.hash';

describe('proposal.hash', () => {
  describe('computePayloadHash', () => {
    it('동일 필드·순서 무관하면 같은 hash', () => {
      const a = computePayloadHash({ ledgerId: 1, mode: 'SET_TIME', occurredAt: '2026-07-01' });
      const b = computePayloadHash({ mode: 'SET_TIME', occurredAt: '2026-07-01', ledgerId: 1 });
      expect(a).toBe(b);
    });

    it('필드가 다르면 다른 hash', () => {
      const a = computePayloadHash({ ledgerId: 1, mode: 'SET_TIME' });
      const b = computePayloadHash({ ledgerId: 1, mode: 'SET_PRICE' });
      expect(a).not.toBe(b);
    });

    it('version prefix 포함', () => {
      const h = computePayloadHash({ x: 1 }, 'v2');
      expect(h).toMatch(/^v2:/);
    });

    it('null 필드 포함', () => {
      const a = computePayloadHash({ x: 1, y: null });
      const b = computePayloadHash({ x: 1 });
      expect(a).not.toBe(b);
    });

    it('undefined 필드 제외', () => {
      const a = computePayloadHash({ x: 1, y: undefined });
      const b = computePayloadHash({ x: 1 });
      expect(a).toBe(b);
    });
  });

  describe('computeAssertionHash', () => {
    it('동일 identity 동일 hash', () => {
      const a = computeAssertionHash({ provider: 'GALAXIA', orderDeliveryId: 100, sourceType: 'USAGE', inboxRowId: 5 });
      const b = computeAssertionHash({ inboxRowId: 5, sourceType: 'USAGE', orderDeliveryId: 100, provider: 'GALAXIA' });
      expect(a).toBe(b);
    });
  });

  describe('computeEvidenceHash', () => {
    it('trim 후 hash', () => {
      const a = computeEvidenceHash('  evidence-ref-123  ');
      const b = computeEvidenceHash('evidence-ref-123');
      expect(a).toBe(b);
    });

    it('다른 증적 다른 hash', () => {
      const a = computeEvidenceHash('ref-1');
      const b = computeEvidenceHash('ref-2');
      expect(a).not.toBe(b);
    });
  });
});
