export interface SmsSendIn {
  msgType: 'S' | 'L' | 'M'; // SMS, LMS, MMS
  to: string; // 수신자 DSTADDR
  from: string; // 발신자 CALLBACK
  subject: string; // SUBJECT
  text: string; // TEXT
  filePath: string[];
  /**
   * 상관키 = `message_attempt.attempt_id` (무작위 UUID hex 32자).
   * Gemtek `MSG_QUEUE.EXT_COL2` 에 기록되어 결과(`MSG_RESULT_yyyyMM`)까지 보존 이관된다.
   * 개인정보·추측 가능한 값(주문번호·수신번호·시각)을 넣지 않는다.
   * (plans/프리미엄_발송실패_재발송_구상.md §3 다·§9 Gemtek DBA 계약)
   *
   * 미지정이면 추적 대상이 아닌 legacy 발송이다(EXT_COL2 = NULL → 부분 unique index 무영향).
   */
  attemptId?: string;
  /**
   * 운영 편의용 non-PII 식별자(`EXT_COL3`). 선택 사항이며 개인정보(email·수신번호·이름) 금지(§8.3).
   */
  traceRef?: string;
}

/**
 * Gemtek insert 결과.
 *
 * `mseq` 는 `MSG_QUEUE` insert 시 `OUTPUT INSERTED.MSEQ` 로 확보한 식별자이며
 * `MSG_RESULT_yyyyMM` 로 동일 값 보존 이관되어 결과 추적 키가 된다(§9 실측 확정).
 * insert 성공은 최종 발송 성공이 아니라 **추적 중**을 의미한다(§2.5).
 */
export interface SmsSendOut {
  mseq: number | null;
  /**
   * `EXT_COL2` unique 위반으로 "이미 insert 됨"이 확인되어 기존 `MSEQ` 를 복구한 경우 true.
   * 신규 insert 가 아니므로 이중 발송이 아니다(§9 Gemtek DBA 계약).
   */
  recovered: boolean;
}

export interface ISmsSend {
  send(obj: SmsSendIn): Promise<SmsSendOut>;
}
