/**
 * erp_macro 조회 API 의 응답 형태.
 *
 * ⚠️ 정본은 문서가 아니라 상대 구현이다.
 *   erp_macro/src/main/java/com/example/erp_macro/api/DepositController.java + DepositView.java
 * 봉투는 전용 DTO(PageResponse)로 content/number/size/totalElements/totalPages 5개 키만 담는다
 * (2026-08-05 확정. Spring Page 가 붙이던 pageable/sort/first/last 등은 없고, 버전 업글에도
 * 형태가 안 바뀐다). 프리미엄 관례인 list/totalCount/currentPage 와 다르니 변환 지점을 여기
 * 한 곳으로 모은다. 프리미엄은 content 와 totalElements 만 읽으므로 키가 늘거나 줄어도 무해하다.
 *
 * matchedOwnerType / matchedOwnerId / matchStatus 는 프리미엄 소유라 이 응답에 없다 —
 * 있어서도 안 된다.
 */
export interface DepositSourceItem {
  /** erp_macro 쪽 행 id. 프리미엄은 dedupKey 를 키로 쓰므로 참고용 */
  id?: number;
  /** SHA-256 지문. 프리미엄의 멱등 upsert 키 */
  dedupKey: string;
  /** 'yyyy-MM-dd' — Java LocalDate 직렬화. 시각·타임존 없음(하루 밀림 방지) */
  txDate: string;
  /** ECOUNT 원문: '입금' | '출금' */
  txType: string;
  accountNo: string;
  accountName: string | null;
  depositor: string;
  erpPartnerName: string | null;
  /** 원 단위 정수 (Java long) */
  amount: number;
  balance: number;
  voucherNo: string | null;
  /**
   * Java Instant 직렬화 (예: '2026-08-04T05:47:00.123456Z').
   * 상대 구현상 **최초 목격 시각**이며 재스크래핑으로 갱신되지 않는다
   * (BankDepositMirrorService 는 재목격 시 voucherNo/거래처만 refresh 한다).
   */
  scrapedAt: string;

  // ↓ 현재 응답에 없는 필드들. erp_macro DB 에는 값이 있으므로 노출을 요청해 둔 상태다.
  //   추가되면 자동으로 채워지고, 그전까지는 null 로 저장된다.
  depositorRaw?: string | null;
  erpPartnerCode?: string | null;
}

/**
 * Spring Data Page 응답 중 프리미엄이 쓰는 부분만.
 * `number` 는 **0-based** 현재 페이지 번호다.
 */
export interface DepositSourcePage {
  content: DepositSourceItem[];
  totalElements: number;
  totalPages: number;
  number: number;
  size: number;
}

/**
 * 수집 상태. pull 방식에서 "데이터가 안 늘어난 것"이 정상인지 스크래퍼 고장인지
 * 구분하려면 이 신호가 필요하다. 돈 화면에서 그 둘을 혼동하면 안 된다.
 *
 * ⚠️ 상대에 아직 /api/status 가 없다(요청해 둔 상태). 없으면 프리미엄은 미러의
 * MAX(synced_at) 만으로 "동기화가 멈췄는지"까지만 판단한다.
 */
export interface DepositSourceStatus {
  /**
   * 마지막으로 **폴링이 성공적으로 완료된** 시각 (ISO 8601). 기동 후 아직 성공 전이면 null.
   * ⚠️ 개별 행의 scrapedAt 이 아니다 — 그 값은 신규 입금이 없는 날엔 스크래퍼가 멀쩡해도
   * 움직이지 않아 "죽었다"는 오탐을 만든다.
   */
  lastScrapedAt: string | null;
  /** 스크래퍼 차단기 작동 여부. true 면 수집이 멈춰 있다(수동 리셋 전까지 유지) */
  gateTripped: boolean;
  gateReason: string | null;
  /**
   * 상대의 폴링 스위치 자체가 켜져 있는지.
   * lastScrapedAt=null 이 "꺼둔 것"인지 "아직 첫 성공 전"인지 구분하는 데 쓴다.
   * (구버전 응답에는 없을 수 있어 optional)
   */
  pollingEnabled?: boolean;
}

/** 재시도해도 소용없는 실패(인증·파라미터). 즉시 중단하고 사람이 봐야 한다. */
export class DepositSourcePermanentError extends Error {}

/** 일시적 실패(네트워크·5xx·타임아웃). 다음 주기에 재시도하면 된다. */
export class DepositSourceTransientError extends Error {}
