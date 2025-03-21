import { format } from 'date-fns';

export class SsgTransactionId {
  // 날짜 포맷: "yyyyMMddHHmmssSSS"
  private static readonly TRADE_DATE_FORMAT = 'yyyyMMddHHmmssSSS';
  private static readonly SEQ_START = 1;
  private static readonly SEQ_END = 999;
  private static seq = 0;

  /**
   * 거래 번호 생성 메소드
   * @returns 생성된 유일한 거래 번호
   */
  public static makeSsgTrade(): string {
    // 시간 값 생성
    const now = new Date();
    const dateString = format(now, SsgTransactionId.TRADE_DATE_FORMAT);

    // 시퀀스 값 증가 및 초기화
    if (SsgTransactionId.seq >= SsgTransactionId.SEQ_END) {
      SsgTransactionId.seq = SsgTransactionId.SEQ_START;
    } else {
      SsgTransactionId.seq++;
    }

    // 시퀀스를 3자리 문자열로 표현
    const seqString = SsgTransactionId.seq.toString().padStart(3, '0');

    return dateString + seqString;
  }
}
