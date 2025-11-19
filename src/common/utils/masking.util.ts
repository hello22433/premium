/**
 * 개인정보 마스킹 유틸리티
 */
export class MaskingUtil {
  /**
   * 전화번호 마스킹 처리
   * 010-1234-5678 -> 010-****-5678
   * 01012345678 -> 010-****-5678
   */
  static maskPhoneNumber(phoneNumber: string): string {
    if (!phoneNumber) return '';

    // 숫자만 추출
    const numbers = phoneNumber.replace(/[^0-9]/g, '');

    if (numbers.length === 11) {
      // 11자리 휴대폰 번호: 010-****-1234
      return `${numbers.substring(0, 3)}-****-${numbers.substring(7, 11)}`;
    } else if (numbers.length === 10) {
      // 10자리 일반전화: 02-****-1234
      return `${numbers.substring(0, 2)}-****-${numbers.substring(6, 10)}`;
    } else if (numbers.length === 8) {
      // 8자리 일반전화: ****-1234
      return `****-${numbers.substring(4, 8)}`;
    } else {
      // 기타 형태는 중간 부분 마스킹
      const length = numbers.length;
      if (length <= 4) {
        return '****';
      }
      const start = numbers.substring(0, 2);
      const end = numbers.substring(length - 2);
      return `${start}****${end}`;
    }
  }

  /**
   * 이메일 마스킹 처리
   * - 아이디가 5글자 이하: 앞 2글자만 보여주고 나머지는 ****로 마스킹
   *   예: abc@test.com -> ab****@test.com
   * - 아이디가 6글자 이상: 앞뒤 2글자만 보여주고 중간은 ****로 마스킹
   *   예: abcdef@test.com -> ab****ef@test.com
   */
  static maskEmail(email: string): string {
    if (!email || !email.includes('@')) return '';

    const [localPart, domain] = email.split('@');
    const localLength = localPart.length;

    if (localLength <= 2) {
      // 2글자 이하는 전체 마스킹
      return `****@${domain}`;
    } else if (localLength <= 5) {
      // 5글자 이하: 앞 2글자만 보여주고 나머지는 ****
      const visiblePart = localPart.substring(0, 2);
      return `${visiblePart}****@${domain}`;
    } else {
      // 6글자 이상: 앞뒤 2글자만 보여주고 중간은 ****
      const firstPart = localPart.substring(0, 2);
      const lastPart = localPart.substring(localLength - 2);
      return `${firstPart}****${lastPart}@${domain}`;
    }
  }

  /**
   * deliveryTarget 마스킹 처리
   * 이메일 형식이면 이메일 마스킹, 아니면 전화번호 마스킹
   */
  static maskDeliveryTarget(deliveryTarget: string): string {
    if (!deliveryTarget) return '';

    // 이메일 형식 체크
    if (deliveryTarget.includes('@')) {
      return this.maskEmail(deliveryTarget);
    } else {
      return this.maskPhoneNumber(deliveryTarget);
    }
  }

  /**
   * 바코드/핀번호 마스킹 처리
   * 첫번째 글자와 마지막 두글자만 남기고 중간은 - 으로 처리
   * 134913491 -> 1-91
   * M103912j32 -> M-32
   */
  static maskPinNumber(value: string): string {
    if (!value) return '';

    const length = value.length;

    if (length <= 2) {
      return value;
    }

    if (length === 3) {
      return `${value.charAt(0)}-${value.charAt(2)}`;
    }

    // 첫 글자 + '-' + 마지막 2글자
    return `${value.charAt(0)}-${value.substring(length - 2)}`;
  }

  /**
   * 핀번호 마스킹 처리
   */
  static maskPersonalCode(personalCode: string): string {
    // 공백 제거
    const trimmedPhone = personalCode.replace(/\s+/g, '');

    // 패턴에 따라 첫 3자리 + **** + 마지막 4자리로 가리기
    return `${trimmedPhone.slice(0, 3)}****${trimmedPhone.slice(-4)}`;
  }
}
