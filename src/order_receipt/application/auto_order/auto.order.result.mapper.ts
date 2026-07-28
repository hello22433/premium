import { IOrderType } from '../../../order/interface/order.type';
import {
  AutoOrderResult,
  AutoOrderRunMode,
  BlockCode,
  BlockField,
  BlockLevel,
  FormatErrorCode,
  ReportExcludedRow,
  ReportProduct,
  ReportUnmappedRow,
  ReportWarningRow,
} from './auto.order.types';

/**
 * 경계 매퍼 — 내부 파이프라인 산출물(AutoOrderResult)을 프론트 계약(TOrderReceiptAutoResult)으로 변환.
 * (sendParams/settlement/orderDeliveryList는 프론트에서 optional·폴백 처리 — 후속 단계에서 채움)
 *
 * ★ 회계(4버킷) 계약 — 프론트 fail-closed 판정의 불변식(FE 요청서 2026-07-28):
 *     expectedDeliveryCount === builtDeliveryCount + unmappedCount + excludedCount + blockedDeliveryCount
 *   blockedDeliveryCount = mapped − built 이므로 좌변 합은 항상 inputRowCount로 수렴한다.
 *   → expectedDeliveryCount에는 반드시 inputRowCount를 싣는다(expectedBuiltCount 아님).
 *
 *   ⚠️ 원자성: count 3종(unmapped/excluded/blocked)과 expectedDeliveryCount=inputRowCount는 반드시 함께
 *   배포해야 한다. count만 추가하면 정상 파일이 ACCOUNTING_ERROR(보라) 오탐, expected만 바꾸면 count 부재로
 *   프론트가 LEGACY 폴백을 타며 input≠built인 정상 파일이 빨강 오탐이 된다.
 *
 *   과거에 expectedBuiltCount를 실었던 이유("기대 N / 구성 0 / ✓일치" 자기모순)는 count 3종이 부재해
 *   프론트가 LEGACY 폴백(expected===built 단순 비교)을 탈 때만 성립한다. count가 함께 오면 프론트는
 *   4버킷 회계로 판정하므로 모순이 없고, 전량 미매핑/제외(생성 0건) 파일이 초록 "✓ 일치"로 오인되는
 *   구멍(운영 재현 2026-07-28)이 닫힌다. matched는 프론트에서 advisory — 배지 판정에 쓰지 않는다.
 *
 * ★ 차단 정보 투영:
 *  1) fileBlocked: 프론트 파일차단 게이트(fileBlocked === true 단독 판정)의 SoT. 미투영 시 게이트가 영구 비활성.
 *  2) blocked(FILE/ORDER, level 포함): 파일 alert에서 FILE 전체차단과 SSG 예약창 밖(ORDER)을 구분하는 정식 경로.
 *  3) blockedRows(ROW, rowNo 포함): ROW 사유의 SoT. 프론트가 warningRows와 합집합·dedupe 처리.
 *  4) fileWarnings(code/reason만): 프론트가 현재 렌더 중인 하위호환 필드 — 삭제 금지(프론트 배포 전까지 사유 표시 담당).
 */

/** dry-run 미리보기 / 실제 생성(승인 후 조회) */
export type AutoResultMode = 'PREVIEW' | 'COMMITTED';

export interface AutoOrderFormatErrorDto {
  code: FormatErrorCode;
  message: string;
}

export interface AutoOrderReconciliationDto {
  inputRowCount: number;
  expectedDeliveryCount: number; // = inputRowCount. 4버킷 합(built+unmapped+excluded+blocked)과 항상 일치
  builtDeliveryCount: number;
  unmappedCount: number;
  excludedCount: number;
  blockedDeliveryCount: number;
  matched: boolean;
}

export interface AutoOrderOrderDto {
  orderId: number | null;
  type: IOrderType;
  eventName: string;
  productCount: number;
  deliveryCount: number;
  products: ReportProduct[];
}

/** 파일 레벨 경고(프론트 fileWarnings). FILE/ORDER 차단 사유를 여기로 노출한다(하위호환 — blocked가 정식 경로). */
export interface AutoOrderFileWarningDto {
  code: BlockCode;
  reason: string;
}

/** 차단 사유(level 포함) — blocked(FILE/ORDER)·blockedRows(ROW)로 노출 */
export interface AutoOrderBlockReasonDto {
  code: BlockCode;
  level: BlockLevel;
  reason: string;
  rowNo?: number; // ROW 레벨일 때 해당 엑셀 행번호
  field?: BlockField; // FORBIDDEN_WORD일 때만
  matched?: string; // 매칭된 금칙어(마스킹)
}

export interface AutoOrderFileResultDto {
  targetFilePath: string;
  fileIndex: number;
  status: 'VALID' | 'INVALID_FORMAT';
  formatError: AutoOrderFormatErrorDto | null;
  reconciliation: AutoOrderReconciliationDto;
  orders: AutoOrderOrderDto[];
  unmappedRows: ReportUnmappedRow[];
  warningRows: ReportWarningRow[];
  excludedRows: ReportExcludedRow[];
  fileBlocked: boolean; // FILE 차단 존재(≠ built===0) — 프론트 파일차단 게이트 SoT
  blocked: AutoOrderBlockReasonDto[]; // FILE/ORDER 사유(level 포함). 없으면 [].
  blockedRows: AutoOrderBlockReasonDto[]; // ROW 사유(rowNo 포함). 없으면 [].
  fileWarnings: AutoOrderFileWarningDto[]; // FILE/ORDER 차단 사유(하위호환). 없으면 [].
}

export interface AutoOrderResultDto {
  mode: AutoResultMode;
  receiptId: number;
  generatedAt: string; // ISO 8601
  files: AutoOrderFileResultDto[];
  summary: {
    fileCount: number;
    validFileCount: number;
    totalOrderCount: number;
    allMatched: boolean;
  };
}

export function runModeToDtoMode(mode: AutoOrderRunMode): AutoResultMode {
  return mode === AutoOrderRunMode.COMMIT ? 'COMMITTED' : 'PREVIEW';
}

export function toAutoOrderResultDto(
  internal: AutoOrderResult,
  opts: { mode: AutoResultMode; receiptId: number; generatedAt: Date },
): AutoOrderResultDto {
  const files: AutoOrderFileResultDto[] = internal.files.map((f) => ({
    targetFilePath: f.targetFilePath,
    fileIndex: f.fileIndex,
    status: f.status,
    formatError:
      f.status === 'INVALID_FORMAT' ? { code: f.formatErrorCode ?? 'HEADER_MISMATCH', message: f.message ?? '' } : null,
    reconciliation: {
      inputRowCount: f.reconciliation.inputRowCount,
      // ★ 4버킷 불변식의 우변 = inputRowCount (expectedBuiltCount 아님 — 파일 상단 주석 참조)
      expectedDeliveryCount: f.reconciliation.inputRowCount,
      builtDeliveryCount: f.reconciliation.builtDeliveryCount,
      unmappedCount: f.reconciliation.unmappedCount,
      excludedCount: f.reconciliation.excludedCount,
      blockedDeliveryCount: f.reconciliation.blockedDeliveryCount,
      matched: f.reconciliation.matched,
    },
    orders: f.orders.map((o) => ({
      orderId: o.orderId,
      type: o.type,
      eventName: o.eventName,
      productCount: o.productCount,
      deliveryCount: o.deliveryCount,
      products: o.products,
    })),
    unmappedRows: f.unmappedRows,
    warningRows: f.warningRows,
    excludedRows: f.excludedRows,
    fileBlocked: f.fileBlocked,
    // 저장 스냅샷(resultJson)은 내부 타입 그대로 직렬화된 과거 데이터일 수 있어 배열 부재를 방어(?? []).
    blocked: (f.blocked ?? []).map(toBlockReasonDto),
    blockedRows: (f.blockedRows ?? []).map(toBlockReasonDto),
    // FILE/ORDER 차단 사유의 하위호환 노출(프론트가 현재 렌더 중 — blocked 소비로 전환 전까지 유지).
    fileWarnings: (f.blocked ?? []).map((b) => ({ code: b.code, reason: b.reason })),
  }));

  const validFiles = files.filter((f) => f.status === 'VALID');
  return {
    mode: opts.mode,
    receiptId: opts.receiptId,
    generatedAt: opts.generatedAt.toISOString(),
    files,
    summary: {
      fileCount: files.length,
      validFileCount: validFiles.length,
      totalOrderCount: files.reduce((sum, f) => sum + f.orders.length, 0),
      allMatched: validFiles.every((f) => f.reconciliation.matched),
    },
  };
}

/** 내부 BlockReason → DTO. 명시 투영으로 내부 필드가 추가돼도 계약이 조용히 넓어지지 않게 한다. */
function toBlockReasonDto(b: {
  code: BlockCode;
  level: BlockLevel;
  reason: string;
  rowNo?: number;
  field?: BlockField;
  matched?: string;
}): AutoOrderBlockReasonDto {
  return {
    code: b.code,
    level: b.level,
    reason: b.reason,
    ...(b.rowNo !== undefined ? { rowNo: b.rowNo } : {}),
    ...(b.field !== undefined ? { field: b.field } : {}),
    ...(b.matched !== undefined ? { matched: b.matched } : {}),
  };
}
