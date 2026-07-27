import { toAutoOrderResultDto } from './auto.order.result.mapper';
import { AutoOrderFileResult, AutoOrderResult } from './auto.order.types';
import { IOrderType } from '../../../order/interface/order.type';

function recon(over: Partial<AutoOrderFileResult['reconciliation']> = {}): AutoOrderFileResult['reconciliation'] {
  const merged = {
    inputRowCount: 0,
    expectedDeliveryCount: 0,
    builtDeliveryCount: 0,
    unmappedCount: 0,
    excludedCount: 0,
    blockedDeliveryCount: 0,
    expectedBuiltCount: 0,
    matched: true,
    ...over,
  };
  // 미지정 시 expectedBuiltCount는 built와 정합(정상 파일 기본 가정)
  if (over.expectedBuiltCount === undefined) merged.expectedBuiltCount = merged.builtDeliveryCount;
  return merged;
}

function validFile(over: Partial<AutoOrderFileResult> = {}): AutoOrderFileResult {
  return {
    fileIndex: 0,
    fileName: 'a.xlsx',
    targetFilePath: 'https://s3/a.xlsx',
    status: 'VALID',
    message: null,
    formatErrorCode: null,
    orders: [
      {
        orderId: 7,
        type: IOrderType.GENERAL,
        eventName: '이벤트',
        productCount: 1,
        deliveryCount: 2,
        sourceRowNos: [5, 6],
        products: [{ productId: 3, productName: '상품A', code: 'GEN-1', faceValue: 5000, deliveryCount: 2 }],
      },
    ],
    reconciliation: recon({ inputRowCount: 2, expectedDeliveryCount: 2, builtDeliveryCount: 2, matched: true }),
    fileBlocked: false,
    blocked: [],
    blockedRows: [],
    unmappedRows: [],
    warningRows: [],
    excludedRows: [],
    ...over,
  };
}

describe('toAutoOrderResultDto', () => {
  const genAt = new Date('2026-08-05T05:30:00.000Z');

  it('봉투(mode/receiptId/generatedAt) + summary 집계', () => {
    const internal: AutoOrderResult = {
      files: [validFile(), validFile({ fileIndex: 1, status: 'INVALID_FORMAT', orders: [], message: '비-xlsx', formatErrorCode: 'NOT_XLSX' })],
      alreadyCommitted: false,
    };
    const dto = toAutoOrderResultDto(internal, { mode: 'PREVIEW', receiptId: 100, generatedAt: genAt });

    expect(dto.mode).toBe('PREVIEW');
    expect(dto.receiptId).toBe(100);
    expect(dto.generatedAt).toBe('2026-08-05T05:30:00.000Z');
    expect(dto.summary).toEqual({ fileCount: 2, validFileCount: 1, totalOrderCount: 1, allMatched: true });
  });

  it('VALID 파일은 formatError=null, 상품 분해 그대로 노출', () => {
    const dto = toAutoOrderResultDto({ files: [validFile()], alreadyCommitted: false }, { mode: 'COMMITTED', receiptId: 1, generatedAt: genAt });
    const f = dto.files[0];
    expect(f.formatError).toBeNull();
    expect(f.targetFilePath).toBe('https://s3/a.xlsx');
    expect(f.orders[0].products[0]).toMatchObject({ code: 'GEN-1', faceValue: 5000, deliveryCount: 2 });
  });

  it('INVALID_FORMAT 파일은 formatError={code,message}', () => {
    const dto = toAutoOrderResultDto(
      { files: [validFile({ status: 'INVALID_FORMAT', message: '지원하지 않는 양식버전', formatErrorCode: 'VERSION_MISMATCH', orders: [] })], alreadyCommitted: false },
      { mode: 'PREVIEW', receiptId: 1, generatedAt: genAt },
    );
    expect(dto.files[0].formatError).toEqual({ code: 'VERSION_MISMATCH', message: '지원하지 않는 양식버전' });
  });

  it('VALID·비차단 파일은 fileWarnings=[]', () => {
    const dto = toAutoOrderResultDto({ files: [validFile()], alreadyCommitted: false }, { mode: 'PREVIEW', receiptId: 1, generatedAt: genAt });
    expect(dto.files[0].fileWarnings).toEqual([]);
  });

  it('FILE 차단 사유를 fileWarnings로 노출 + expectedDeliveryCount는 expectedBuilt(모순 제거)', () => {
    // 행사명 금칙어 → FILE 차단. status=VALID·orders=[]이지만 사유가 fileWarnings로 나가야 "이유 없는 0건"이 아님.
    const blocked = validFile({
      orders: [],
      blocked: [{ code: 'FORBIDDEN_WORD', level: 'FILE', field: 'EVENT_NAME', reason: '프로모션명(C19)에 금칙어가 포함되어 있습니다.' }],
      reconciliation: recon({ inputRowCount: 5, builtDeliveryCount: 0, expectedBuiltCount: 0, matched: true }),
    });
    const dto = toAutoOrderResultDto({ files: [blocked], alreadyCommitted: false }, { mode: 'PREVIEW', receiptId: 1, generatedAt: genAt });
    const f = dto.files[0];
    expect(f.fileWarnings).toEqual([{ code: 'FORBIDDEN_WORD', reason: '프로모션명(C19)에 금칙어가 포함되어 있습니다.' }]);
    expect(f.orders).toHaveLength(0);
    // 내부 inputRowCount=5지만 DTO 기대발송수=expectedBuilt=0 → "기대 0 / 구성 0 / ✓일치" 정합
    expect(f.reconciliation.expectedDeliveryCount).toBe(0);
    expect(f.reconciliation.builtDeliveryCount).toBe(0);
  });

  it('SSG 예약창 밖(ORDER 차단)도 fileWarnings로 노출', () => {
    const blocked = validFile({
      blocked: [{ code: 'SSG_RESERVATION_WINDOW', level: 'ORDER', reason: 'SSG 예약 가능 기간이 아닙니다.' }],
    });
    const dto = toAutoOrderResultDto({ files: [blocked], alreadyCommitted: false }, { mode: 'PREVIEW', receiptId: 1, generatedAt: genAt });
    expect(dto.files[0].fileWarnings).toEqual([{ code: 'SSG_RESERVATION_WINDOW', reason: 'SSG 예약 가능 기간이 아닙니다.' }]);
  });

  it('allMatched: VALID 파일 중 하나라도 matched=false면 false (INVALID_FORMAT은 계산 제외)', () => {
    const internal: AutoOrderResult = {
      files: [
        validFile({ reconciliation: recon({ matched: true }) }),
        validFile({ fileIndex: 1, reconciliation: recon({ matched: false }) }),
        validFile({ fileIndex: 2, status: 'INVALID_FORMAT', orders: [], reconciliation: recon({ matched: false }) }),
      ],
      alreadyCommitted: false,
    };
    const dto = toAutoOrderResultDto(internal, { mode: 'PREVIEW', receiptId: 1, generatedAt: genAt });
    expect(dto.summary.allMatched).toBe(false);
    expect(dto.summary.validFileCount).toBe(2);
  });
});
