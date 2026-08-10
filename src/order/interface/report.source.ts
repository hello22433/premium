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

/**
 * 발행 이력 조회(GET /order/:orderId/report-history)가 받는 리포트 타입.
 *
 * activity_log.action_type 값과 1:1 이며, 기본 타입 2종은 조회 시 대응 *_EMAIL 이력까지
 * 함께 반환된다(activity.log.service.REPORT_HISTORY_ACTION_TYPES).
 *
 * DTO 검증과 서비스 매핑이 이 목록을 공유해야 한다 — 따로 두면 한쪽만 늘어났을 때
 * 컴파일은 통과하고 조회만 조용히 빈 결과를 내는 상태가 된다.
 */
export const REPORT_HISTORY_TYPES = [
  'DELIVERY_COMPLETE_REPORT',
  'TRANSACTION_STATEMENT',
  // 파기확약서는 카운트 컬럼이 없어 발행 집계 대상이 아니지만, PDF 발행 자체는
  // actionType='DESTRUCTION_CERTIFICATE' 로 기록된다(destructionCertificatePdf).
  // 목록에서 빼면 기존에 조회되던 이력이 400 이 되므로 반드시 포함한다.
  'DESTRUCTION_CERTIFICATE',
  'DELIVERY_COMPLETE_REPORT_EMAIL',
  'TRANSACTION_STATEMENT_EMAIL',
  'DESTRUCTION_CERTIFICATE_EMAIL',
] as const;

export type IReportHistoryType = (typeof REPORT_HISTORY_TYPES)[number];
