import { ExternalApiException } from '../api/external.api.exception.filter';

/**
 * 협력사 raw 에러를 외부 API 표준 에러로 변환한다.
 *
 * 외부 응답에는 협력사 식별자/원본 코드/원본 메시지가 절대 포함되지 않는다.
 * 매핑되지 않은 케이스는 컨텍스트별 기본 코드를 사용한다.
 *
 * 매핑 근거: 0_ePOPKON 루트의 협력사 응답 코드 docs
 *   - cultureland_cancel.md
 *   - galaxia_api_check_cancel.md
 *   - daou_response_code.md
 *   - giftiel_response_code.md
 */

export type TranslateContext = 'issue' | 'cancel' | 'resend';

type Partner = 'CULTURELAND' | 'GALAXIA' | 'DAOU' | 'GIFTIEL';

interface Mapping {
  code: string;
  message: string;
  detail?: string;
}

const PARTNER_TAG_PATTERN = /\[(CULTURELAND|GALAXIA|DAOU|GIFTIEL):([^\]]+)\]/i;

const PARTNER_CODE_MAP: Record<Partner, Record<string, Mapping>> = {
  CULTURELAND: {
    '9101': { code: '3004', message: '쿠폰 취소 실패', detail: '발급 등록 정보 오류' },
    '9102': { code: '3004', message: '쿠폰 취소 실패', detail: '내부 처리 오류' },
    '9103': { code: '4001', message: '주문을 찾을 수 없음', detail: '존재하지 않는 핀번호' },
    '9104': { code: '3005', message: '이미 취소된 주문' },
    '9105': { code: '3004', message: '쿠폰 취소 실패', detail: '내부 처리 오류' },
    '9106': { code: '3006', message: '이미 사용된 쿠폰' },
    '9901': { code: '3004', message: '쿠폰 취소 실패', detail: '요청 형식 오류' },
    '9902': { code: '3004', message: '쿠폰 취소 실패', detail: '일시적 처리 오류' },
    '0099': { code: '3004', message: '쿠폰 취소 실패', detail: '일시적 처리 오류' },
  },
  GALAXIA: {
    '2202': { code: '4001', message: '주문을 찾을 수 없음', detail: '유효하지 않은 쿠폰' },
    '2203': { code: '3004', message: '쿠폰 취소 실패', detail: '발행 처리 중' },
    '2204': { code: '3005', message: '이미 취소된 주문' },
    '2205': { code: '3007', message: '만료된 쿠폰' },
    '2206': { code: '3006', message: '이미 사용된 쿠폰' },
    '2208': { code: '3005', message: '이미 취소된 주문', detail: '이미 환불 처리됨' },
    '2209': { code: '3009', message: '취소 불가 상품' },
    '2210': { code: '3009', message: '취소 불가 상품' },
    '2215': { code: '3009', message: '취소 불가 상품' },
    '2220': { code: '3009', message: '취소 불가 상품' },
    '2230': { code: '3009', message: '취소 불가 상품' },
    '2510': { code: '4001', message: '주문을 찾을 수 없음' },
    '4110': { code: '3002', message: '잔액 부족' },
    '4201': { code: '4001', message: '주문을 찾을 수 없음' },
    '4520': { code: '2001', message: '잘못된 요청', detail: '파라미터 오류' },
    '4530': { code: '2001', message: '잘못된 요청', detail: '파라미터 형식 오류' },
    '4540': { code: '2001', message: '잘못된 요청', detail: '값 범위 오류' },
    '4900': { code: '2005', message: '요청 처리 중', detail: '주문번호 중복' },
    '5100': { code: '3004', message: '쿠폰 취소 실패', detail: '내부 처리 오류' },
    '5701': { code: '3008', message: '재발송 횟수 초과' },
    '5900': { code: '3004', message: '쿠폰 취소 실패' },
    '5950': { code: '3004', message: '쿠폰 취소 실패' },
    '5990': { code: '3004', message: '쿠폰 취소 실패' },
    '020009': { code: '4001', message: '주문을 찾을 수 없음' },
    '020012': { code: '4001', message: '주문을 찾을 수 없음' },
    '020014': { code: '3002', message: '잔액 부족' },
    '020015': { code: '3005', message: '이미 취소된 주문' },
    '020016': { code: '3009', message: '취소 불가 상품' },
    '020017': { code: '3005', message: '이미 취소된 주문' },
    '030003': { code: '4001', message: '주문을 찾을 수 없음' },
    '030005': { code: '3005', message: '이미 취소된 주문' },
    '030007': { code: '3007', message: '만료된 쿠폰' },
    '030009': { code: '4001', message: '주문을 찾을 수 없음' },
    '030012': { code: '3009', message: '취소 불가 상품' },
    '030016': { code: '3007', message: '만료된 쿠폰' },
  },
  DAOU: {
    E000010: { code: '3002', message: '잔액 부족', detail: '발행 한도 초과' },
    E000020: { code: '3008', message: '재발송 횟수 초과' },
    E000022: { code: '3004', message: '쿠폰 취소 실패', detail: '사용할 수 없는 쿠폰' },
    E000023: { code: '3004', message: '쿠폰 취소 실패' },
    E000024: { code: '3002', message: '잔액 부족', detail: '발행 개수 초과' },
    E000025: { code: '4001', message: '주문을 찾을 수 없음' },
    E000300: { code: '3003', message: '쿠폰 발행 실패', detail: '발행 처리 오류' },
    E000301: { code: '3004', message: '쿠폰 취소 실패', detail: '재발송 정보 오류' },
    E000305: { code: '3004', message: '쿠폰 취소 실패', detail: '폐기 정보 오류' },
    E005004: { code: '3004', message: '쿠폰 취소 실패' },
    E005005: { code: '3004', message: '쿠폰 취소 실패' },
    E005006: { code: '3007', message: '만료된 쿠폰' },
    E005100: { code: '3004', message: '쿠폰 취소 실패', detail: '발행 처리 오류' },
    E007007: { code: '3008', message: '재발송 횟수 초과' },
  },
  GIFTIEL: {
    '0204': { code: '4001', message: '주문을 찾을 수 없음' },
    '0207': { code: '3004', message: '쿠폰 취소 실패', detail: '일시적 처리 오류' },
    '0214': { code: '4001', message: '주문을 찾을 수 없음' },
    '0215': { code: '3005', message: '이미 취소된 주문' },
    '0216': { code: '3009', message: '취소 불가 상품' },
    '0217': { code: '3006', message: '이미 사용된 쿠폰' },
    '0218': { code: '3007', message: '만료된 쿠폰' },
    '0219': { code: '3005', message: '이미 취소된 주문' },
    '0220': { code: '3009', message: '취소 불가 상품' },
    '0221': { code: '3006', message: '이미 사용된 쿠폰' },
    '0222': { code: '3007', message: '만료된 쿠폰' },
    '0223': { code: '3005', message: '이미 취소된 주문' },
    '1100': { code: '4001', message: '주문을 찾을 수 없음' },
    '1101': { code: '4001', message: '주문을 찾을 수 없음' },
    '1102': { code: '4001', message: '주문을 찾을 수 없음' },
    '1200': { code: '3005', message: '이미 취소된 주문' },
    '2002': { code: '3003', message: '쿠폰 발행 실패', detail: '발행 처리 오류' },
    '9000': { code: '3004', message: '쿠폰 취소 실패', detail: '내부 처리 오류' },
    '9001': { code: '3004', message: '쿠폰 취소 실패', detail: '내부 처리 오류' },
    '9002': { code: '3004', message: '쿠폰 취소 실패', detail: '일부 처리 실패' },
  },
};

const CONTEXT_DEFAULTS: Record<TranslateContext, Mapping> = {
  issue: { code: '3003', message: '쿠폰 발행 실패' },
  cancel: { code: '3004', message: '쿠폰 취소 실패' },
  resend: { code: '3004', message: '재발송 불가' },
};

function extractRawMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return '';
}

function toMapping(error: unknown, context: TranslateContext): Mapping {
  const match = PARTNER_TAG_PATTERN.exec(extractRawMessage(error));
  if (match) {
    const partner = match[1].toUpperCase() as Partner;
    const code = match[2].trim();
    const mapped = PARTNER_CODE_MAP[partner]?.[code];
    if (mapped) return mapped;
  }
  return CONTEXT_DEFAULTS[context];
}

export function translatePartnerError(error: unknown, context: TranslateContext): ExternalApiException {
  const { code, message, detail } = toMapping(error, context);
  return new ExternalApiException(code, message, detail);
}
