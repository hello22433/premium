/**
 * 갤럭시아 잔액형 쿠폰 사용 판정.
 *
 * galaxia check 응답의 isUsed 플래그는 부분 사용(잔액 잔존) 시 false 로 내려오므로,
 * 액면가 대비 실제 사용액(faceValue - balance)을 함께 본다.
 *  - isActuallyUsed: isUsed 이거나 1원이라도 사용(잔액 감소)했으면 true → 교환(USED) 판정
 *  - fullBalanceRemains: 잔액이 전액 남음(balance >= faceValue) → 사용취소/미사용, 교환정보 제거 대상
 *
 * faceValue 가 0/누락/비정상이면(hasFaceValue=false) 사용액 비교를 신뢰할 수 없으므로
 * isUsed 단독 판정으로 폴백한다(fullBalanceRemains=false).
 */
export interface GalaxiaUsageVerdict {
  balance: number;
  isActuallyUsed: boolean;
  fullBalanceRemains: boolean;
}

export function resolveGalaxiaUsage(giftCertificate: {
  isUsed: boolean;
  faceValue: string;
  balance: string;
}): GalaxiaUsageVerdict {
  const faceValue = Number(giftCertificate.faceValue);
  const balance = Number(giftCertificate.balance);
  const hasFaceValue = Number.isFinite(faceValue) && faceValue > 0 && Number.isFinite(balance);
  const usedAmount = hasFaceValue ? faceValue - balance : 0;

  return {
    balance,
    isActuallyUsed: giftCertificate.isUsed || usedAmount > 0,
    fullBalanceRemains: hasFaceValue && balance >= faceValue,
  };
}
