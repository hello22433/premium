import { IOrderType } from '../../../order/interface/order.type';
import {
  AutoOrderResult,
  AutoOrderRunMode,
  FormatErrorCode,
  ReportExcludedRow,
  ReportProduct,
  ReportUnmappedRow,
  ReportWarningRow,
} from './auto.order.types';

/**
 * 경계 매퍼 — 내부 파이프라인 산출물(AutoOrderResult)을 프론트 계약(TOrderReceiptAutoResult)으로 변환.
 * 내부 리포트에는 검산 내부값(blocked/blockedRows 등)이 있지만 프론트가 쓰는 필드만 노출한다.
 * (sendParams/settlement/orderDeliveryList/fileWarnings는 프론트에서 optional·폴백 처리 — 후속 단계에서 채움)
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
      expectedDeliveryCount: f.reconciliation.expectedDeliveryCount,
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
