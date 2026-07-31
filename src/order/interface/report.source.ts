/**
 * 리포트(발송완료리포트 / 거래명세서) 발행 소스.
 *
 * order.delivery_report_last_source / order.transaction_statement_last_source 에 저장되며,
 * 정산 목록의 발행 상태 문구(settle.service.formatReportStatus)가 이 값으로 분기한다.
 * 저장 컬럼이 varchar(20) 이므로 값 추가 시 길이를 넘지 않도록 주의.
 *
 * ⚠️ 발행 카운트(deliveryCompleteReportCount / orderCompleteReportCount)를 올리는 경로만
 *    이 값을 쓴다. 다중(통합) 발행 경로 GET /order/*-complete/report-multiple 은 카운트도
 *    activity_log 도 남기지 않으므로 여기 해당 값이 없다(별도 티켓).
 */
export enum IReportSource {
  /** 문서함에서 PDF 다운로드 */
  DOCUMENT = 'DOCUMENT',
  /** 상세 화면에서 직접 발행(단건 PDF) */
  DIRECT = 'DIRECT',
  /** 고객사에 이메일로 전송 */
  EMAIL = 'EMAIL',
}

/**
 * 클라이언트가 PDF 발행 API 로 직접 보낼 수 있는 소스.
 *
 * EMAIL 은 제외한다 — 서버가 메일 전송 경로(sendReportEmail)에서만 기록하는 값이라,
 * 클라이언트 입력으로 허용하면 메일을 보낸 적 없이 정산 목록을 '발행 완료'로 만들 수 있다.
 */
export const CLIENT_SETTABLE_REPORT_SOURCES = {
  DOCUMENT: IReportSource.DOCUMENT,
  DIRECT: IReportSource.DIRECT,
} as const;
