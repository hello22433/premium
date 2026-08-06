/**
 * bank_deposit.match_status — 입금 건이 고객에 연결됐는지의 상태.
 *
 * ⚠️ **이 값의 정본은 프리미엄이다.** erp_macro 는 이 컬럼의 존재조차 모르고, 조회 API 응답에도
 * 없다. 동기화 upsert 의 갱신 컬럼 목록에서 제외되어 있는 것이 그 소유권의 실제 강제 수단이다
 * (deposit.sync.service.ts). 여기를 "상대가 정본"으로 읽고 갱신 목록에 넣으면 운영자가 방금
 * 지정한 매칭이 5분마다 조용히 UNMATCHED 로 되돌아간다.
 *
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
