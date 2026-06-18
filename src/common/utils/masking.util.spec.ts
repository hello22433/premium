import { MaskingUtil } from './masking.util';

describe('MaskingUtil.maskActivityLogParams', () => {
  it('객체가 아니면 그대로 반환하고 null/undefined 는 null 로 정규화한다', () => {
    expect(MaskingUtil.maskActivityLogParams(null)).toBeNull();
    expect(MaskingUtil.maskActivityLogParams(undefined)).toBeNull();
    expect(MaskingUtil.maskActivityLogParams('raw')).toBe('raw');
    expect(MaskingUtil.maskActivityLogParams(['a'])).toEqual(['a']);
  });

  it('PII 검색/수신처 필드는 마스킹한다', () => {
    const masked = MaskingUtil.maskActivityLogParams({
      deliveryTarget: '01012345678',
      keyword: '01099998888',
      recipientPhone: '01055554444',
      barCode: '1234567890',
      personalCode: '9001011234567',
    }) as Record<string, string>;

    expect(masked.deliveryTarget).toBe('010-****-5678');
    expect(masked.keyword).toBe('010-****-8888');
    expect(masked.recipientPhone).toBe('010-****-4444');
    expect(masked.barCode).not.toBe('1234567890');
    expect(masked.barCode).toContain('*');
    expect(masked.personalCode).not.toBe('9001011234567');
  });

  it('감사·표시용 키(targetUserId/source/to/cc/memo/금액)는 보존한다', () => {
    const input = {
      targetUserId: 42,
      targetUserEmail: 'admin@test.com',
      source: 'MANUAL',
      to: 'user@test.com',
      cc: 'cc@test.com',
      memo: '폐기복구/ 10000원',
      chargeAmount: 5000,
    };
    const masked = MaskingUtil.maskActivityLogParams(input) as typeof input;

    expect(masked.targetUserId).toBe(42);
    expect(masked.targetUserEmail).toBe('admin@test.com');
    expect(masked.source).toBe('MANUAL');
    expect(masked.to).toBe('user@test.com');
    expect(masked.cc).toBe('cc@test.com');
    expect(masked.memo).toBe('폐기복구/ 10000원');
    expect(masked.chargeAmount).toBe(5000);
  });

  it('원본 객체를 변형하지 않는다(얕은 복사)', () => {
    const input = { deliveryTarget: '01012345678' };
    MaskingUtil.maskActivityLogParams(input);
    expect(input.deliveryTarget).toBe('01012345678');
  });

  it('빈 문자열·비문자열 값은 건드리지 않는다', () => {
    const masked = MaskingUtil.maskActivityLogParams({
      deliveryTarget: '',
      barCode: 12345,
    }) as Record<string, unknown>;
    expect(masked.deliveryTarget).toBe('');
    expect(masked.barCode).toBe(12345);
  });
});
