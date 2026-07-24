import { IOrderType } from '../../../order/interface/order.type';
import {
  AutoOrderResult,
  AutoOrderRunMode,
  BlockCode,
  FormatErrorCode,
  ReportExcludedRow,
  ReportProduct,
  ReportUnmappedRow,
  ReportWarningRow,
} from './auto.order.types';

/**
 * 경계 매퍼 — 내부 파이프라인 산출물(AutoOrderResult)을 프론트 계약(TOrderReceiptAutoResult)으로 변환.
 * 내부 리포트에는 검산 내부값(blockedRows/blockedDeliveryCount 등)이 있지만 프론트가 쓰는 필드만 노출한다.
 * (sendParams/settlement/orderDeliveryList는 프론트에서 optional·폴백 처리 — 후속 단계에서 채움)
 *
 * ★ 두 축을 프론트 계약으로 투영한다(리뷰 반영):
 *  1) FILE/ORDER 차단 사유(blocked) → fileWarnings: 안 하면 파일이 status=VALID·orders=[]인데 사유가
 *     화면 어디에도 안 떠 관리자가 "이유 없이 0건"을 본다(제목/내용/행사명 금칙어·발신수단·EMAIL발신·소유자·SSG창밖).
 *  2) reconciliation.expectedDeliveryCount ← expectedBuiltCount: 내부값은 inputRowCount지만, 그대로 노출하면
 *     "기대발송 N / 구성발송 0 / ✓일치" 자기모순이 뜬다. 프론트 계약(Σ수량=기대발송)에 맞춰 built와 정합한 값으로.
 */

/** dry-run 미리보기 / 실제 생성(승인 후 조회) */
export type AutoResultMode = 'PREVIEW' | 'COMMITTED';

export interface AutoOrderFormatErrorDto {
  code: FormatErrorCode;
  message: string;
}

export interface AutoOrderReconciliationDto {
  inputRowCount: number;
  expectedDeliveryCount: number;
  builtDeliveryCount: number;
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

/** 파일 레벨 경고(프론트 fileWarnings). FILE/ORDER 차단 사유를 여기로 노출한다. */
export interface AutoOrderFileWarningDto {
  code: BlockCode;
  reason: string;
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
  fileWarnings: AutoOrderFileWarningDto[]; // FILE/ORDER 차단 사유(금칙어/발신수단/EMAIL발신/소유자/SSG창밖). 없으면 [].
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
      f.status === 'INVALID_FORMAT'
        ? { code: f.formatErrorCode ?? 'HEADER_MISMATCH', message: f.message ?? '' }
        : null,
    reconciliation: {
      inputRowCount: f.reconciliation.inputRowCount,
      // 프론트 계약(Σ수량=기대발송)에 맞춰 built와 정합한 expectedBuilt를 노출(inputRowCount 아님).
      expectedDeliveryCount: f.reconciliation.expectedBuiltCount,
      builtDeliveryCount: f.reconciliation.builtDeliveryCount,
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
    // FILE/ORDER 차단 사유를 프론트 fileWarnings로 노출(ROW 차단은 warningRows에 이미 나감).
    fileWarnings: f.blocked.map((b) => ({ code: b.code, reason: b.reason })),
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
