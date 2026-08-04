/**
 * bank_deposit.match_status — 입금 건이 고객에 연결됐는지의 상태.
 *
 * 값의 정본은 erp_macro 의 MatchStatus enum 이며, 프리미엄은 표시만 한다.
 * 매핑·충전 기능이 아직 가동 전이라 현재 운영 데이터는 사실상 전부 UNMATCHED 다.
 */
export enum DepositMatchStatus {
  /** 매핑되지 않음(기본값) */
  UNMATCHED = 'UNMATCHED',
  /** 입금처→고객 매핑으로 연결됨 */
  MAPPED = 'MAPPED',
  /** 후보가 둘 이상이라 사람이 정해야 함 */
  AMBIGUOUS = 'AMBIGUOUS',
  /** 예치금 충전까지 반영됨(터미널 상태) */
  CREDITED = 'CREDITED',
}
