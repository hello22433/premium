import { IOrderSendMethod } from '../../../order/interface/order.send.method';
import { ProductEntity } from '../../../entity/product.entity';

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
