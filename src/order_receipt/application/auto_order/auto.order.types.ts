import { IOrderSendMethod } from '../../../order/interface/order.send.method';
import { ProductEntity } from '../../../entity/product.entity';
import { SsgReservationRangeBoundary } from '../../../order/domain/order.validation';
import { OrderCreateTempReqDto } from '../../../order/api/order.req.dto';
import { IOrderType } from '../../../order/interface/order.type';

/**
 * 자동주문 파이프라인 공용 타입.
 * (blocked/reconciliation 등 뒤 단계 타입은 해당 Phase에서 추가한다)
 */

/** 파일 양식 판정 결과 상태 */
export type AutoOrderFileStatus = 'VALID' | 'INVALID_FORMAT' | 'ALREADY_COMMITTED';

/**
 * 발신수단별 수신처: EMAIL이면 이메일(D), 그 외엔 휴대폰(B). 없으면 null.
 * 사전검증(MISSING_DELIVERY_TARGET 판정)과 payload조립(usableRows 필터)이 반드시 같은 규칙을
 * 써야 "사전검증 통과했는데 조립 단계가 행을 조용히 drop"하는 불일치가 생기지 않으므로 단일 소스로 공유한다.
 */
export function resolveDeliveryTarget(
  sendMethod: IOrderSendMethod | null,
  row: { email: string | null; phone: string | null },
): string | null {
  return sendMethod === IOrderSendMethod.EMAIL ? row.email : row.phone;
}

/** 1단계 파서 산출물 - 1.신청정보 시트(주문 공통값) */
export interface ParsedHeader {
  formVersion: string; // C1
  eventName: string; // C19
  sendTitle: string; // C20
  sendContent: string; // C21
  sendMethod: IOrderSendMethod | null; // C23 (알림톡/문자/이메일 → enum)
  fromPhoneNumber: string; // C24
  isImmediate: boolean | null; // C16 (true=즉시/false=예약/null=해석불가 → 구조검증에서 리젝)
  sendDate: string; // C17 원본 문자열(텍스트셀='YYYY-MM-DD', 네이티브 날짜셀=ISO). sendRequestAt 도출에만 사용
  sendTime: string; // C18 원본 문자열(텍스트셀='HH:MM', 네이티브 시간셀=ISO). sendRequestAt 도출에만 사용
  sendRequestAt: Date | null; // C17+C18 (KST) - 즉시발송이면 null
  destroyDay: number; // C25
}

/** 1단계 파서 산출물 - 2.발송명단 시트 한 행(수신자 1명) */
export interface ParsedRow {
  rowNo: number; // 엑셀 실제 행번호(5부터). 리포트 추적용으로 끝까지 보존
  phone: string | null; // B
  email: string | null; // D
  productCode: string | null; // H (상품명 G에서 자동 도출된 코드)
  amount: number; // J (수식 =IF(B="","",1)). 휴대폰(B) 있으면 1, 이메일 전용 행은 B가 비어 0이 될 수 있음 → 수량은 payload 단계에서 행 수로 계산(J 신뢰 안 함)
  isValid: boolean; // M (_유효, TRUE/FALSE)
  statusReason: string | null; // N (_상태: format_error/duplicate/unselected/ok)
  replaceCharacter1: string | null; // P
  replaceCharacter2: string | null; // Q
  replaceCharacter3: string | null; // R
}

/** 1단계 파서 산출물 - 파일 1개 파싱 결과 */
export interface ParsedFile {
  header: ParsedHeader | null; // 시트 없으면 null
  rows: ParsedRow[];
  parseError: 'SHEET_MISSING' | 'FORMULA_NOT_CACHED' | null;
}

/** 구조검증/파일 실패 사유 코드 (프론트 계약 5종) */
export type FormatErrorCode = 'NOT_XLSX' | 'MISSING_SHEET' | 'HEADER_MISMATCH' | 'VERSION_MISMATCH' | 'EMPTY_LIST';

/** 2단계 구조검증 결과 */
export interface StructureResult {
  status: 'VALID' | 'INVALID_FORMAT';
  message: string | null; // INVALID_FORMAT일 때 사유
  code: FormatErrorCode | null; // INVALID_FORMAT일 때 프론트 계약 코드
}

/** 3단계 - 상품이 매핑된 행(ParsedRow + product) */
export interface MappedRow extends ParsedRow {
  product: ProductEntity;
}

/**
 * 3단계 상품매핑/분기 결과.
 * 입력 행은 4갈래로 서로소 분할된다: excluded / unmapped / general / ssg
 * (blocked는 4단계에서 general·ssg 안에서 추가로 갈린다)
 */
export interface MappedResult {
  excludedRows: ParsedRow[]; // _유효=False (엑셀이 스스로 무효 표시)
  unmappedRows: ParsedRow[]; // 상품코드가 DB에 없음
  generalRows: MappedRow[]; // 비-SSG 상품 → 일반 주문
  ssgRows: MappedRow[]; // SSG 상품 → SSG 주문
}

// ── 4단계 사전검증(blocked) ────────────────────────────────
// createTemp가 throw할 조건(금칙어/발신수단/SSG예약창)을 미리 scan해 blocked로 변환한다.

/** 차단 레벨: 파일 전체 / SSG 주문만 / 특정 수신자 행만 */
export type BlockLevel = 'FILE' | 'ORDER' | 'ROW';

/** 차단 사유 코드 (프론트 계약) */
export type BlockCode =
  | 'FORBIDDEN_WORD'
  | 'SSG_RESERVATION_WINDOW'
  | 'SEND_METHOD_NOT_ALLOWED'
  | 'MISSING_DELIVERY_TARGET' // 발신수단에 맞는 수신처(휴대폰/이메일)가 행에 없음
  | 'RECEIPT_OWNER_MISSING' // 접수 소유자(기업 사용자)를 찾을 수 없음
  | 'EMAIL_SENDER_MISSING'; // 이메일 발신주소(등록/기본계정)를 확보할 수 없음

/** 금칙어 적발 필드 (code === 'FORBIDDEN_WORD'일 때만) */
export type BlockField = 'TITLE' | 'CONTENT' | 'REPLACE_CHAR';

export interface BlockReason {
  code: BlockCode;
  reason: string;
  level: BlockLevel;
  rowNo?: number; // ROW 레벨일 때 해당 엑셀 행번호
  field?: BlockField; // FORBIDDEN_WORD일 때만
  matched?: string; // 매칭된 금칙어(마스킹)
}

/** 4단계 입력. SSG range/allowedSendMethods는 상위(오케스트레이터)가 조회해 주입 → 사전검증은 순수 로직 */
export interface PreValidateInput {
  header: ParsedHeader;
  generalRows: MappedRow[];
  ssgRows: MappedRow[];
  userAllowedSendMethods: string | null; // user.allowedSendMethods 원본(콤마구분), null이면 전체 허용
  ssgReservationRange: SsgReservationRangeBoundary | null; // SSG 예약 가능 범위(미설정 시 당월 폴백)
  ownerMissing: boolean; // 접수 소유자 조회 실패 → FILE 차단(소유자 없이 전체허용 폴백 금지)
  resolvedFromEmail: string | null; // EMAIL 발신주소(등록 우선, 없으면 하이웍스 기본). EMAIL인데 null이면 FILE 차단
}

export interface PreValidateResult {
  blocked: BlockReason[]; // FILE/ORDER/ROW 사유 전부(표시용, 중복 보고 가능)
  blockedRowNos: Set<number>; // ROW 차단된 엑셀 행번호(카운트/제외용, 1회만)
  ssgOrderBlocked: boolean; // SSG 주문 스킵 여부(예약창 밖)
  fileBlocked: boolean; // FILE 레벨 차단 존재 → 파일 주문 0건
}

// ── 5단계 payload 조립 ─────────────────────────────────────

/** 5단계 입력 (주문 1건분: general 또는 ssg 행 묶음) */
export interface BuildPayloadInput {
  header: ParsedHeader;
  rows: MappedRow[]; // 이 주문 종류의 매핑 행들
  orderType: IOrderType;
  blockedRowNos: Set<number>; // 4단계 ROW 차단 → 제외
  fromEmail?: string | null; // EMAIL 발신주소(오케스트레이터가 주입). EMAIL 아닐 땐 미사용
}

/** 리포트용 상품/권종 요약 (프론트 orders[].products[]) */
export interface ReportProduct {
  productId: number | null; // 미매핑이면 null(주문 내부에선 항상 매핑됨)
  productName: string;
  code: string;
  faceValue: number; // 정상가(product.price)
  deliveryCount: number; // 이 상품의 발송건 수
}

/** 5단계 결과. createTemp payload + 리포트/검산용 소스 행번호(payload엔 못 담음) */
export interface BuildPayloadResult {
  payload: OrderCreateTempReqDto;
  sourceRowNos: number[]; // 이 주문에 실제로 들어간 엑셀 행번호
  products: ReportProduct[]; // 상품별 분해(리포트용)
}

// ── 6단계 리포트/검산 (프론트 계약) ─────────────────────────

/**
 * 회계 검산. 4버킷(excluded/unmapped/mapped)은 입력행의 서로소 분할이며
 *   expectedDeliveryCount === builtDeliveryCount + unmappedCount + excludedCount + blockedDeliveryCount
 * 이 항상 성립한다(blockedDeliveryCount = mapped − built).
 * ★ matched는 이 항등식이 아니라, 차단 이유로 독립 산출한 기대생성수와 실제 built의 일치로 판정한다
 *   (built === expectedBuilt). 조립이 사유 없이 행을 흘리거나(under) 이중계상하면(over) matched=false.
 */
export interface AutoOrderReconciliation {
  inputRowCount: number;
  expectedDeliveryCount: number;
  builtDeliveryCount: number;
  unmappedCount: number;
  excludedCount: number;
  blockedDeliveryCount: number;
  matched: boolean;
}

/** 미리보기/승인 리포트의 주문 1건 */
export interface AutoOrderReportOrder {
  orderId: number | null; // DRY_RUN=null, COMMIT=생성된 order.id
  type: IOrderType;
  eventName: string;
  productCount: number; // 상품 종수
  deliveryCount: number; // 발송건 수(=수신자 수)
  sourceRowNos: number[]; // 이 주문에 들어간 엑셀 행번호
  products: ReportProduct[]; // 상품별 분해(프론트 orders[].products[])
}

/** 리포트 행 분류(프론트 계약) */
export interface ReportUnmappedRow {
  rowNo: number;
  code: string; // 미등록 상품코드
  reason: string;
}
export interface ReportWarningRow {
  rowNo: number;
  code: string;
  reason: string;
}
export interface ReportExcludedRow {
  rowNo: number;
  reason: string;
}

/** 파일 1개 처리 결과 */
export interface AutoOrderFileResult {
  fileIndex: number;
  fileName: string;
  targetFilePath: string; // 파싱 대상 파일 경로(프론트 targetFilePath — 표시명 도출용)
  status: AutoOrderFileStatus;
  message: string | null; // INVALID_FORMAT 사유
  formatErrorCode: FormatErrorCode | null; // INVALID_FORMAT 프론트 계약 코드
  orders: AutoOrderReportOrder[];
  reconciliation: AutoOrderReconciliation;
  fileBlocked: boolean; // FILE 차단 존재(≠ built===0)
  blocked: BlockReason[]; // FILE/ORDER 사유
  blockedRows: BlockReason[]; // ROW 사유
  unmappedRows: ReportUnmappedRow[]; // 미등록 상품코드 행(프론트 계약)
  warningRows: ReportWarningRow[]; // ROW 차단 사유(금칙어/수신처없음 등)를 경고로 표시
  excludedRows: ReportExcludedRow[]; // _유효=False 행
}

/** 접수 1건(파일 N개) 전체 결과 */
export interface AutoOrderResult {
  files: AutoOrderFileResult[];
  alreadyCommitted: boolean; // 멱등 재처리로 저장 스냅샷을 반환한 경우
}

/** 실행 모드: 미리보기(DB 무변경) / 승인(실제 생성) */
export enum AutoOrderRunMode {
  DRY_RUN = 'DRY_RUN',
  COMMIT = 'COMMIT',
}
