/**
 * 전화번호 정규화 유틸리티
 */
export class PhoneUtil {
  /**
   * 전화번호에서 하이픈을 제거하고 숫자만 반환
   * @param phone 전화번호 (예: 010-1234-5678 또는 01012345678)
   * @returns 숫자만 포함된 전화번호 (예: 01012345678)
   */
  static normalize(phone: string): string {
    if (!phone) return phone;
    // 숫자만 추출
    return phone.replace(/\D/g, '');
  }

  /**
   * 이메일 또는 전화번호 정규화
   * - 이메일이면 그대로 반환
   * - 전화번호면 하이픈 제거
   * @param target 이메일 또는 전화번호
   * @returns 정규화된 문자열
   */
  static normalizeDeliveryTarget(target: string): string {
    if (!target) return target;

    // 이메일 형식인 경우 그대로 반환
    if (target.includes('@')) {
      return target;
    }

    // 전화번호인 경우 하이픈 제거
    return this.normalize(target);
  }
}
