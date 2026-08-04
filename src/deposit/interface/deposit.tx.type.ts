/**
 * bank_deposit.tx_type — ECOUNT 화면의 '구분' 값.
 *
 * DB 에는 스크래핑 원문 그대로 한글('입금'/'출금')이 들어간다. API 계약까지 한글에
 * 묶으면 ECOUNT 문구가 바뀔 때 프론트까지 함께 깨지므로, 바깥으로는 영문 키를
 * 노출하고 이 파일 한 곳에서만 DB 값으로 번역한다.
 */
export enum DepositTxType {
  /** 입금 */
  DEPOSIT = 'DEPOSIT',
  /** 출금 */
  WITHDRAW = 'WITHDRAW',
}

/** API 영문 키 → DB 한글 값 */
export const DEPOSIT_TX_TYPE_TO_DB: Record<DepositTxType, string> = {
  [DepositTxType.DEPOSIT]: '입금',
  [DepositTxType.WITHDRAW]: '출금',
};

/**
 * DB 한글 값 → API 영문 키.
 * 스크래핑 원문이 예상 밖의 값이면 null 을 돌려주고, 원문은 별도 필드로 함께 내보낸다.
 * (모르는 값을 임의로 DEPOSIT 으로 접어버리면 출금이 입금으로 보이는 사고가 난다)
 */
export const toDepositTxType = (dbValue: string): DepositTxType | null => {
  const found = Object.entries(DEPOSIT_TX_TYPE_TO_DB).find(([, korean]) => korean === dbValue);
  return found ? (found[0] as DepositTxType) : null;
};
