/**
 * 실패내역 화면 노출용 코드 카탈로그 (plans/프리미엄_발송실패_재발송_구상.md §1·§4·§8).
 *
 * 코드 네임스페이스를 계층별로 분리해 표기한다 — 세 계층의 같은 숫자는 서로 다른 사건이다.
 * - `HTTP_*`             : 전송계층 HTTP 상태
 * - `PARTNER_RESPONSE_*` : 협력사 PIN 발급 원본 응답
 * - `GEMTEK_RESULT_*`    : Gemtek 문자 결과 코드
 *
 * `autoResendEligible` 은 **정책상 자동 재발송 후보인지**만 나타낸다. 실제 실행 여부는
 * `DELIVERY_AUTO_RESEND_504_ENABLED` 플래그와 체인당 1회 unique 가 별도로 통제한다(§10 4단계).
 */

export interface FailureCodeView {
  /** 네임스페이스가 붙은 표기 코드 (예: `GEMTEK_RESULT_504`) */
  code: string;
  /** 원본 코드 (예: `504`) */
  rawCode: string;
  /** 코드 설명 */
  description: string;
  /** 운영자가 취해야 할 조치 */
  opsAction: string;
  /** 정책상 자동 재발송 후보 여부 */
  autoResendEligible: boolean;
}

interface CatalogEntry {
  description: string;
  opsAction: string;
  autoResendEligible?: boolean;
}

/** Gemtek 문자 결과 코드표 (§4 확정표 + 2026-07-24 실측 분포) */
const GEMTEK_RESULT_CATALOG: Record<string, CatalogEntry> = {
  '0': { description: '전송 성공(E_OK)', opsAction: '조치 불필요' },
  '203': { description: '번호 오류', opsAction: '수신번호 확인 후 정정 재발송(자동 재발송 대상 아님)' },
  '503': { description: '스팸·수신거부 차단', opsAction: '수신자 확인 필요(자동 재발송 금지)' },
  '504': {
    description: '이통사 만료(expired) — 접수 약 24시간 뒤 확정',
    opsAction: '자동 재발송 대상. 자동 재발송이 비활성이면 수동 재발송',
    autoResendEligible: true,
  },
  '505': { description: '착신 가입자 없음', opsAction: '수신번호 확인 필요(자동 재발송 금지)' },
  '519': {
    description: '이통사 기타(E_TELCO_ETC) — 전달 여부 불명',
    opsAction: '전달 여부 확인 후 운영 판단(자동 재발송 금지)',
  },
  '520': { description: '일시정지 회선', opsAction: '수신자 상태 확인 후 수동 처리(자동 재발송 금지)' },
};

/** 협력사 PIN 발급 응답 분류별 기본 조치 (§9 분류표 버킷) */
const PARTNER_RESPONSE_CLASS_ACTION: Record<string, string> = {
  SUCCESS: '조치 불필요',
  DUPLICATE: '기존 발급 PIN 복구 대상(재발급 아님)',
  RETRYABLE: '결과 조회로 미발급 확인 후 1회 재발급',
  TERMINAL: '재시도 무의미 — 잔액·한도·상품 상태 확인 후 운영 종결',
  UNKNOWN: '발급 여부 불명 — 결과 재조회 후 운영 확인(신규 발급 기본 금지)',
};

/** Gemtek `RESULT` 원본 코드를 화면 표기용으로 변환한다. */
export function describeGemtekResult(result: string | null | undefined): FailureCodeView | null {
  if (!result) {
    return null;
  }
  const entry = GEMTEK_RESULT_CATALOG[result];
  return {
    code: `GEMTEK_RESULT_${result}`,
    rawCode: result,
    description: entry?.description ?? '미분류 결과 코드',
    opsAction: entry?.opsAction ?? '코드표 미등록 — 운영 확인 필요(자동 재발송 금지)',
    autoResendEligible: entry?.autoResendEligible ?? false,
  };
}

/** 협력사 PIN 발급 원본 응답코드를 화면 표기용으로 변환한다. */
export function describePartnerResponse(
  responseCode: string | null | undefined,
  responseClass: string | null | undefined,
): FailureCodeView | null {
  if (!responseCode) {
    return null;
  }
  return {
    code: `PARTNER_RESPONSE_${responseCode}`,
    rawCode: responseCode,
    description: responseClass ? `협력사 응답 분류 ${responseClass}` : '협력사 응답 분류 미판정',
    opsAction:
      (responseClass && PARTNER_RESPONSE_CLASS_ACTION[responseClass]) ??
      '분류 미판정 — 결과 재조회 후 운영 확인(신규 발급 금지)',
    autoResendEligible: false,
  };
}
