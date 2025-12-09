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

  /**
   * 전화번호에 하이픈 추가 (휴대폰 번호 전용)
   * @param phone 전화번호 (예: 01012345678)
   * @returns 하이픈이 포함된 전화번호 (예: 010-1234-5678)
   */
  static formatWithHyphen(phone: string): string {
    if (!phone) return phone;

    const digits = phone.replace(/\D/g, '');

    if (digits.length === 11) {
      return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
    }

    return phone;
  }

  /**
   * 유효한 전화번호인지 검증 (010으로 시작하는 11자리 휴대폰 번호)
   * @param phone 전화번호
   * @returns 유효한 전화번호면 true
   */
  static isValidPhone(phone: string): boolean {
    if (!phone) return false;

    const digits = phone.replace(/\D/g, '');

    // 11자리 체크
    if (digits.length !== 11) return false;

    // 숫자만 포함되어 있는지 체크
    if (!/^\d{11}$/.test(digits)) return false;

    // 010으로 시작하는지 체크
    if (!digits.startsWith('010')) return false;

    // 4번째 자리가 0 또는 1이 아닌지 체크 (2-9만 허용)
    const fourthDigit = digits[3];
    if (fourthDigit === '0' || fourthDigit === '1') return false;

    return /^010[2-9][0-9]{7}$/.test(digits);
  }

  /**
   * 유효한 이메일인지 검증
   * @param email 이메일 주소
   * @returns 유효한 이메일이면 true
   */
  static isValidEmail(email: string): boolean {
    if (!email) return false;
    const emailRegex = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
    return emailRegex.test(email);
  }
}
