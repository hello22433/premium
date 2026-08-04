/**
 * erp_macro 조회 API 의 응답 형태.
 * 계약 정본: docs/API계약-erp_macro-입금내역-조회.md
 *
 * 이 인터페이스는 "남이 주는 것"의 모양이라 프리미엄 엔티티와 1:1 이 아니다.
 * 특히 matchedUserId / matchStatus 는 프리미엄 소유라 여기에 **없어야** 한다.
 */
export interface DepositSourceItem {
  /** SHA-256 지문. 프리미엄의 멱등 upsert 키 */
  dedupKey: string;
  /** 'yyyy-MM-dd' — 시각·타임존 없는 날짜 문자열 (하루 밀림 방지) */
  txDate: string;
  /** ECOUNT 원문: '입금' | '출금' */
  txType: string;
  accountNo: string;
  accountName: string | null;
  erpPartnerCode: string | null;
  erpPartnerName: string | null;
  depositor: string;
  depositorRaw: string | null;
  /** 원 단위 정수 */
  amount: number;
  balance: number;
  voucherNo: string | null;
  /** ISO 8601 + 오프셋 */
  scrapedAt: string;
  updatedAt: string;
}

export interface DepositSourcePage {
  items: DepositSourceItem[];
  page: number;
  size: number;
  totalCount: number;
}

/**
 * 수집 상태. pull 방식에서 "데이터가 안 늘어난 것"이 정상인지 스크래퍼 고장인지
 * 구분하려면 이 신호가 필요하다. 돈 화면에서 그 둘을 혼동하면 안 된다.
 */
export interface DepositSourceStatus {
  /** 마지막으로 스크래핑에 성공한 시각 (ISO 8601 + 오프셋). 한 번도 없으면 null */
  lastScrapedAt: string | null;
  /** 스크래퍼 차단기 작동 여부. true 면 수집이 멈춰 있다 */
  gateTripped: boolean;
  gateReason: string | null;
}

/** 재시도해도 소용없는 실패(인증·파라미터). 즉시 중단하고 사람이 봐야 한다. */
export class DepositSourcePermanentError extends Error {}

/** 일시적 실패(네트워크·5xx·타임아웃). 다음 주기에 재시도하면 된다. */
export class DepositSourceTransientError extends Error {}
