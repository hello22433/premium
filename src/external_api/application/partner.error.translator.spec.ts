import { translatePartnerError, TranslateContext } from './partner.error.translator';
import { ExternalApiException } from '../api/external.api.exception.filter';

const PARTNER_NAMES = ['CULTURELAND', 'GALAXIA', 'DAOU', 'GIFTIEL'];

function expectNoLeak(detail: string | undefined) {
  if (!detail) return;
  for (const name of PARTNER_NAMES) {
    expect(detail).not.toContain(name);
  }
  expect(detail).not.toMatch(/\[[A-Z]+:[^\]]+\]/);
}

describe('translatePartnerError', () => {
  describe('CULTURELAND 매핑', () => {
    it('9104 사용정지/취소 → 3005 이미 취소된 주문', () => {
      const error = new Error('[CULTURELAND:9104] 사용정지 되었거나 취소된 상품권');
      const result = translatePartnerError(error, 'cancel');
      expect(result.code).toBe('3005');
      expect(result.errorMessage).toBe('이미 취소된 주문');
      expect(result.detail).toBeUndefined();
    });

    it('9106 이미 사용 → 3006', () => {
      const error = new Error('[CULTURELAND:9106] 이미 사용된 상품권');
      const result = translatePartnerError(error, 'cancel');
      expect(result.code).toBe('3006');
    });

    it('9103 원장 없음 → 4001', () => {
      const error = new Error('[CULTURELAND:9103] 원장에 없거나 잘못된 상품권번호');
      const result = translatePartnerError(error, 'cancel');
      expect(result.code).toBe('4001');
    });
  });

  describe('GALAXIA 매핑', () => {
    it('2204 already canceled → 3005', () => {
      const error = new Error('[GALAXIA:2204] already canceled coupon');
      const result = translatePartnerError(error, 'cancel');
      expect(result.code).toBe('3005');
    });

    it('2206 used → 3006', () => {
      const error = new Error('[GALAXIA:2206] used coupon');
      const result = translatePartnerError(error, 'cancel');
      expect(result.code).toBe('3006');
    });

    it('2205 expired → 3007', () => {
      const error = new Error('[GALAXIA:2205] expired coupon');
      const result = translatePartnerError(error, 'cancel');
      expect(result.code).toBe('3007');
    });

    it('030005 dept 이미 취소 → 3005', () => {
      const error = new Error('[GALAXIA:030005] 이미 취소된 거래 정보');
      const result = translatePartnerError(error, 'cancel');
      expect(result.code).toBe('3005');
    });

    it('4110 잔액 부족 → 3002', () => {
      const error = new Error('[GALAXIA:4110] Insufficient Fund');
      const result = translatePartnerError(error, 'issue');
      expect(result.code).toBe('3002');
    });
  });

  describe('DAOU 매핑', () => {
    it('E005006 만료 → 3007', () => {
      const error = new Error('[DAOU:E005006] 쿠폰 기간만료 오류');
      const result = translatePartnerError(error, 'cancel');
      expect(result.code).toBe('3007');
    });

    it('E007007 재발송 횟수 초과 → 3008', () => {
      const error = new Error('[DAOU:E007007] 쿠폰 재발송 횟수 초과');
      const result = translatePartnerError(error, 'resend');
      expect(result.code).toBe('3008');
    });

    it('E000010 발행 한도 초과 → 3002', () => {
      const error = new Error('[DAOU:E000010] 쿠폰 발행 한도가 초과되었습니다.');
      const result = translatePartnerError(error, 'issue');
      expect(result.code).toBe('3002');
    });
  });

  describe('GIFTIEL 매핑', () => {
    it('0215 이미 취소된 주문 → 3005', () => {
      const error = new Error('[GIFTIEL:0215] 이미 취소처리된 주문번호입니다.');
      const result = translatePartnerError(error, 'cancel');
      expect(result.code).toBe('3005');
    });

    it('0217 사용된 쿠폰 → 3006', () => {
      const error = new Error('[GIFTIEL:0217] 사용된 쿠폰은 취소할 수 없습니다.');
      const result = translatePartnerError(error, 'cancel');
      expect(result.code).toBe('3006');
    });

    it('0218 만료된 쿠폰 → 3007', () => {
      const error = new Error('[GIFTIEL:0218] 유효기간이 종료된 쿠폰');
      const result = translatePartnerError(error, 'cancel');
      expect(result.code).toBe('3007');
    });

    it('0220 취소 불가 상품 → 3009', () => {
      const error = new Error('[GIFTIEL:0220] 해당상품은 취소할 수 없는상품으로 설정되어있습니다.');
      const result = translatePartnerError(error, 'cancel');
      expect(result.code).toBe('3009');
    });
  });

  describe('컨텍스트 기본값 fallback', () => {
    it('issue 컨텍스트 + 매핑 없는 raw → 3003', () => {
      const error = new Error('[CULTURELAND:9999] 알 수 없는 오류');
      const result = translatePartnerError(error, 'issue');
      expect(result.code).toBe('3003');
      expect(result.errorMessage).toBe('쿠폰 발행 실패');
      expect(result.detail).toBeUndefined();
    });

    it('cancel 컨텍스트 + 매핑 없는 raw → 3004', () => {
      const error = new Error('[GALAXIA:9999] 알 수 없는 오류');
      const result = translatePartnerError(error, 'cancel');
      expect(result.code).toBe('3004');
      expect(result.errorMessage).toBe('쿠폰 취소 실패');
    });

    it('resend 컨텍스트 + 매핑 없는 raw → 3004 재발송 불가', () => {
      const error = new Error('[DAOU:E999999] 알 수 없는 오류');
      const result = translatePartnerError(error, 'resend');
      expect(result.code).toBe('3004');
      expect(result.errorMessage).toBe('재발송 불가');
    });

    it('partner 태그 없는 일반 Error → 컨텍스트 기본값', () => {
      const error = new Error('발송 실패');
      const result = translatePartnerError(error, 'issue');
      expect(result.code).toBe('3003');
      expect(result.detail).toBeUndefined();
    });

    it('string 에러 → 컨텍스트 기본값', () => {
      const result = translatePartnerError('타임아웃', 'cancel');
      expect(result.code).toBe('3004');
    });

    it('null 에러 → 컨텍스트 기본값', () => {
      const result = translatePartnerError(null, 'cancel');
      expect(result.code).toBe('3004');
    });
  });

  describe('협력사 식별자/원본 코드 노출 차단', () => {
    const samples: Array<[string, TranslateContext]> = [
      ['[CULTURELAND:9104] 사용정지', 'cancel'],
      ['[CULTURELAND:9999] 알 수 없는 오류', 'cancel'],
      ['[GALAXIA:2204] already canceled coupon', 'cancel'],
      ['[GALAXIA:5990] System error', 'issue'],
      ['[DAOU:E000022] 사용할 수 없는 쿠폰', 'cancel'],
      ['[DAOU:E999999] 발행 실패', 'issue'],
      ['[GIFTIEL:0217] 사용된 쿠폰', 'cancel'],
      ['[GIFTIEL:9000] 시스템 오류', 'cancel'],
    ];

    it.each(samples)('%s 변환 시 detail에 협력사 식별자 미포함', (rawMessage, context) => {
      const result = translatePartnerError(new Error(rawMessage), context);
      expect(result).toBeInstanceOf(ExternalApiException);
      expect(result.errorMessage).not.toMatch(/\[[A-Z]+:[^\]]+\]/);
      for (const name of PARTNER_NAMES) {
        expect(result.errorMessage).not.toContain(name);
      }
      expectNoLeak(result.detail);
    });
  });
});
