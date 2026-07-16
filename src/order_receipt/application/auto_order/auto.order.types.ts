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

/** 1단계 파서 산출물 - 1.신청정보 시트(주문 공통값) */
export interface ParsedHeader {
  formVersion: string; // C1
  eventName: string; // C19
  sendTitle: string; // C20
  sendContent: string; // C21
  sendMethod: IOrderSendMethod | null; // C23 (알림톡/문자/이메일 → enum)
  fromPhoneNumber: string; // C24
  isImmediate: boolean; // C16
  sendDate: string; // C17 원본 (YYYY-MM-DD)
  sendTime: string; // C18 원본 (HH:MM)
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
  parseError: 'SHEET_MISSING' | null;
}

/** 2단계 구조검증 결과 */
export interface StructureResult {
  status: 'VALID' | 'INVALID_FORMAT';
  message: string | null; // INVALID_FORMAT일 때 사유
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
export type BlockCode = 'FORBIDDEN_WORD' | 'SSG_RESERVATION_WINDOW' | 'SEND_METHOD_NOT_ALLOWED';

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
}

/** 5단계 결과. createTemp payload + 리포트/검산용 소스 행번호(payload엔 못 담음) */
export interface BuildPayloadResult {
  payload: OrderCreateTempReqDto;
  sourceRowNos: number[]; // 이 주문에 실제로 들어간 엑셀 행번호
}
