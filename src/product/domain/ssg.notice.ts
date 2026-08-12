/**
 * 신세계 상품 유의사항(product.memo) 도메인 규칙.
 *
 * 이 문구는 발송 문자(smsSsgTemplate)와 알림톡·이메일 쿠폰 페이지가 함께 읽는 정본이다.
 * 운영자가 화면에서 직접 고치므로, 저장할 때 입력한 모양이 그대로 남아야 한다.
 */

/** product.memo 컬럼 상한(varchar 4000). */
export const PRODUCT_MEMO_MAX_LENGTH = 4000;

/**
 * 운영자가 textarea 에 입력한 문구를 저장 형태로 정규화한다.
 *
 * 줄바꿈만 LF 로 통일하고 공백·들여쓰기·빈 줄은 하나도 건드리지 않는다.
 * - 브라우저 textarea 는 줄바꿈을 CRLF 로 보낸다. 그대로 저장하면 줄마다 1바이트씩 더 먹어
 *   문자 발송 바이트 수와 저장 길이가 입력 환경에 따라 달라진다.
 * - 문구 사이 빈 줄은 문자 본문에서 문단 구분자로 쓰이므로 절대 제거하지 않는다(splitSsgNotice).
 */
export function normalizeSsgNotice(notice: string): string {
  return notice.replace(/\r\n?/g, '\n');
}
