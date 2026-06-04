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

    // 파기된 데이터('-')는 그대로 반환
    if (deliveryTarget === '-') return '-';

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
   * 바코드 마스킹 처리
   * 중간 4자리를 *로 치환
   * 123456789 -> 12****789
   */
  static maskBarCode(barCode: string): string {
    if (barCode.length <= 4) return '*'.repeat(barCode.length);
    const start = barCode.slice(0, Math.floor((barCode.length - 4) / 2));
    const masked = '*'.repeat(4);
    const end = barCode.slice(-Math.ceil((barCode.length - 4) / 2));
    return `${start}${masked}${end}`;
  }

  static maskPersonalCode(personalCode: string): string {
    // 공백 제거
    const trimmedPhone = personalCode.replace(/\s+/g, '');

    // 패턴에 따라 첫 3자리 + **** + 마지막 4자리로 가리기
    return `${trimmedPhone.slice(0, 3)}****${trimmedPhone.slice(-4)}`;
  }

  /**
   * 인물 이름 마스킹: 첫 글자만 노출, 나머지는 *
   * 김민수 → 김**
   */
  static maskPersonName(name: string): string {
    if (name.length <= 1) return '*';
    return name.charAt(0) + '*'.repeat(name.length - 1);
  }

  /**
   * 브랜드명 마스킹: 뒤 2글자(은행/카드 등 식별자)만 노출, 나머지는 *
   * 현대카드 → **카드, 신한은행 → **은행
   */
  static maskBrandName(name: string): string {
    if (name.length <= 2) return '*'.repeat(name.length);
    return '*'.repeat(name.length - 2) + name.slice(-2);
  }

  /**
   * 사업자등록번호 로그 마스킹: 앞 5자리 노출, 뒷자리 5개 마스킹
   * 125-05-51212 → 125-05-*****
   */
  static maskBusinessNumber(number: string): string {
    const clean = number.replace(/[^0-9]/g, '');
    if (clean.length === 10) return `${clean.slice(0, 3)}-${clean.slice(3, 5)}-*****`;
    return `${clean.slice(0, 3)}-****`;
  }

  /**
   * 카드번호 로그 마스킹: 앞뒤 4자리 노출, 가운데 8자리 마스킹
   * 1234-5678-9012-3456 → 1234-****-****-3456
   */
  static maskCardNumber(number: string): string {
    const clean = number.replace(/[^0-9]/g, '');
    if (clean.length === 16) return `${clean.slice(0, 4)}-****-****-${clean.slice(12)}`;
    if (clean.length === 15) return `${clean.slice(0, 4)}-****-****-${clean.slice(11)}`;
    return `${clean.slice(0, 4)}-****`;
  }
}
