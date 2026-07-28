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
    pendingSsgProducts: [],
    warningRows: [],
    excludedRows: [],
    ...over,
  };
}

describe('toAutoOrderResultDto', () => {
  const genAt = new Date('2026-08-05T05:30:00.000Z');

  it('봉투(mode/receiptId/generatedAt) + summary 집계', () => {
    const internal: AutoOrderResult = {
      files: [
        validFile(),
        validFile({
          fileIndex: 1,
          status: 'INVALID_FORMAT',
          orders: [],
          message: '비-xlsx',
          formatErrorCode: 'NOT_XLSX',
        }),
      ],
      alreadyCommitted: false,
    };
    const dto = toAutoOrderResultDto(internal, { mode: 'PREVIEW', receiptId: 100, generatedAt: genAt });

    expect(dto.mode).toBe('PREVIEW');
    expect(dto.receiptId).toBe(100);
    expect(dto.generatedAt).toBe('2026-08-05T05:30:00.000Z');
    expect(dto.summary).toEqual({ fileCount: 2, validFileCount: 1, totalOrderCount: 1, allMatched: true });
  });

  it('VALID 파일은 formatError=null, 상품 분해 그대로 노출', () => {
    const dto = toAutoOrderResultDto(
      { files: [validFile()], alreadyCommitted: false },
      { mode: 'COMMITTED', receiptId: 1, generatedAt: genAt },
    );
    const f = dto.files[0];
    expect(f.formatError).toBeNull();
    expect(f.targetFilePath).toBe('https://s3/a.xlsx');
    expect(f.orders[0].products[0]).toMatchObject({ code: 'GEN-1', faceValue: 5000, deliveryCount: 2 });
  });

  it('INVALID_FORMAT 파일은 formatError={code,message}', () => {
    const dto = toAutoOrderResultDto(
      {
        files: [
          validFile({
            status: 'INVALID_FORMAT',
            message: '지원하지 않는 양식버전',
            formatErrorCode: 'VERSION_MISMATCH',
            orders: [],
          }),
        ],
        alreadyCommitted: false,
      },
      { mode: 'PREVIEW', receiptId: 1, generatedAt: genAt },
    );
    expect(dto.files[0].formatError).toEqual({ code: 'VERSION_MISMATCH', message: '지원하지 않는 양식버전' });
  });

  it('VALID·비차단 파일은 fileBlocked=false, blocked/blockedRows/fileWarnings=[]', () => {
    const dto = toAutoOrderResultDto(
      { files: [validFile()], alreadyCommitted: false },
      { mode: 'PREVIEW', receiptId: 1, generatedAt: genAt },
    );
    const f = dto.files[0];
    expect(f.fileBlocked).toBe(false);
    expect(f.blocked).toEqual([]);
    expect(f.blockedRows).toEqual([]);
    expect(f.fileWarnings).toEqual([]);
  });

  // ── 회계(4버킷) 계약: expectedDeliveryCount = inputRowCount = built + unmapped + excluded + blocked ──
  // FE 요청서(2026-07-28) §5 검증표. expectedBuiltCount를 실으면 count 3종과 함께 불변식이 깨진다(§3).

  function expectInvariant(f: ReturnType<typeof toAutoOrderResultDto>['files'][number]) {
    const r = f.reconciliation;
    expect(r.expectedDeliveryCount).toBe(r.inputRowCount);
    expect(r.builtDeliveryCount + r.unmappedCount + r.excludedCount + r.blockedDeliveryCount).toBe(
      r.expectedDeliveryCount,
    );
  }

  it('회계 케이스1 전량 정상: expected=input=10, 4버킷 합 성립', () => {
    const file = validFile({
      reconciliation: recon({ inputRowCount: 10, expectedDeliveryCount: 10, builtDeliveryCount: 10 }),
    });
    const dto = toAutoOrderResultDto(
      { files: [file], alreadyCommitted: false },
      { mode: 'PREVIEW', receiptId: 1, generatedAt: genAt },
    );
    const r = dto.files[0].reconciliation;
    expect(r).toEqual({
      inputRowCount: 10,
      expectedDeliveryCount: 10,
      builtDeliveryCount: 10,
      unmappedCount: 0,
      excludedCount: 0,
      blockedDeliveryCount: 0,
      matched: true,
    });
    expectInvariant(dto.files[0]);
  });

  it('회계 케이스2 미매핑1·제외1: count 3종이 DTO로 투영되고 합이 성립', () => {
    const file = validFile({
      reconciliation: recon({
        inputRowCount: 10,
        expectedDeliveryCount: 10,
        builtDeliveryCount: 8,
        unmappedCount: 1,
        excludedCount: 1,
        blockedDeliveryCount: 0,
      }),
    });
    const dto = toAutoOrderResultDto(
      { files: [file], alreadyCommitted: false },
      { mode: 'PREVIEW', receiptId: 1, generatedAt: genAt },
    );
    const r = dto.files[0].reconciliation;
    expect(r.unmappedCount).toBe(1);
    expect(r.excludedCount).toBe(1);
    expect(r.blockedDeliveryCount).toBe(0);
    expectInvariant(dto.files[0]);
  });

  it('회계 케이스3 전량 미매핑/제외(운영 재현: 생성 0건): expected=2≠built=0 — LEGACY "0===0 초록" 오탐 차단', () => {
    // 내부 expectedBuiltCount=0(built와 정합, matched=true)이지만 DTO expected는 inputRowCount=2여야 한다.
    // expectedBuilt(0)를 실으면 count 부재 폴백에서 0===0 → 주문 0건인데 초록 "✓ 일치"가 된다(운영 사고 2026-07-28).
    const file = validFile({
      orders: [],
      reconciliation: recon({
        inputRowCount: 2,
        expectedDeliveryCount: 2,
        builtDeliveryCount: 0,
        unmappedCount: 1,
        excludedCount: 1,
        blockedDeliveryCount: 0,
        expectedBuiltCount: 0,
        matched: true,
      }),
    });
    const dto = toAutoOrderResultDto(
      { files: [file], alreadyCommitted: false },
      { mode: 'COMMITTED', receiptId: 1, generatedAt: genAt },
    );
    const r = dto.files[0].reconciliation;
    expect(r.expectedDeliveryCount).toBe(2); // ★ expectedBuilt(0) 아님
    expect(r.builtDeliveryCount).toBe(0);
    expectInvariant(dto.files[0]);
  });

  it('회계 케이스6 SSG 예약창 밖 부분 차단: blocked=4 투영, 합 성립', () => {
    const file = validFile({
      blocked: [{ code: 'SSG_RESERVATION_WINDOW', level: 'ORDER', reason: 'SSG 예약 가능 기간이 아닙니다.' }],
      reconciliation: recon({
        inputRowCount: 10,
        expectedDeliveryCount: 10,
        builtDeliveryCount: 6,
        blockedDeliveryCount: 4,
        expectedBuiltCount: 6,
      }),
    });
    const dto = toAutoOrderResultDto(
      { files: [file], alreadyCommitted: false },
      { mode: 'PREVIEW', receiptId: 1, generatedAt: genAt },
    );
    expect(dto.files[0].reconciliation.blockedDeliveryCount).toBe(4);
    expectInvariant(dto.files[0]);
  });

  // ── 차단 정보 투영 ──────────────────────────────────────────

  it('FILE 차단: fileBlocked=true + blocked(level 포함) + fileWarnings(하위호환) 동시 노출, expected=input 유지', () => {
    // 행사명 금칙어 → FILE 차단(전량). 프론트 게이트는 fileBlocked===true 단독 판정 — boolean이 반드시 나가야 한다.
    const blocked = validFile({
      orders: [],
      fileBlocked: true,
      blocked: [
        {
          code: 'FORBIDDEN_WORD',
          level: 'FILE',
          field: 'EVENT_NAME',
          reason: '프로모션명(C19)에 금칙어가 포함되어 있습니다.',
          matched: '도*',
        },
      ],
      reconciliation: recon({
        inputRowCount: 5,
        expectedDeliveryCount: 5,
        builtDeliveryCount: 0,
        blockedDeliveryCount: 5,
        expectedBuiltCount: 0,
        matched: true,
      }),
    });
    const dto = toAutoOrderResultDto(
      { files: [blocked], alreadyCommitted: false },
      { mode: 'PREVIEW', receiptId: 1, generatedAt: genAt },
    );
    const f = dto.files[0];
    expect(f.fileBlocked).toBe(true);
    expect(f.blocked).toEqual([
      {
        code: 'FORBIDDEN_WORD',
        level: 'FILE',
        field: 'EVENT_NAME',
        reason: '프로모션명(C19)에 금칙어가 포함되어 있습니다.',
        matched: '도*',
      },
    ]);
    expect(f.fileWarnings).toEqual([
      { code: 'FORBIDDEN_WORD', reason: '프로모션명(C19)에 금칙어가 포함되어 있습니다.' },
    ]);
    expect(f.orders).toHaveLength(0);
    expect(f.reconciliation.expectedDeliveryCount).toBe(5); // inputRowCount — expectedBuilt(0) 아님
    expectInvariant(f);
  });

  it('SSG 예약창 밖(ORDER 차단): blocked에 level=ORDER로 노출 → FILE 전체차단과 구분 가능', () => {
    const blocked = validFile({
      blocked: [{ code: 'SSG_RESERVATION_WINDOW', level: 'ORDER', reason: 'SSG 예약 가능 기간이 아닙니다.' }],
    });
    const dto = toAutoOrderResultDto(
      { files: [blocked], alreadyCommitted: false },
      { mode: 'PREVIEW', receiptId: 1, generatedAt: genAt },
    );
    const f = dto.files[0];
    expect(f.fileBlocked).toBe(false);
    expect(f.blocked).toEqual([
      { code: 'SSG_RESERVATION_WINDOW', level: 'ORDER', reason: 'SSG 예약 가능 기간이 아닙니다.' },
    ]);
    expect(f.fileWarnings).toEqual([{ code: 'SSG_RESERVATION_WINDOW', reason: 'SSG 예약 가능 기간이 아닙니다.' }]);
  });

  it('ROW 차단: blockedRows에 rowNo 포함 노출(ROW 사유의 SoT)', () => {
    const file = validFile({
      blockedRows: [
        { code: 'MISSING_DELIVERY_TARGET', level: 'ROW', rowNo: 7, reason: '수신처(휴대폰번호)가 없습니다.' },
        {
          code: 'FORBIDDEN_WORD',
          level: 'ROW',
          rowNo: 9,
          field: 'REPLACE_CHAR',
          reason: '대치문자에 금칙어가 포함되어 있습니다.',
          matched: '도*',
        },
      ],
    });
    const dto = toAutoOrderResultDto(
      { files: [file], alreadyCommitted: false },
      { mode: 'PREVIEW', receiptId: 1, generatedAt: genAt },
    );
    expect(dto.files[0].blockedRows).toEqual([
      { code: 'MISSING_DELIVERY_TARGET', level: 'ROW', rowNo: 7, reason: '수신처(휴대폰번호)가 없습니다.' },
      {
        code: 'FORBIDDEN_WORD',
        level: 'ROW',
        rowNo: 9,
        field: 'REPLACE_CHAR',
        reason: '대치문자에 금칙어가 포함되어 있습니다.',
        matched: '도*',
      },
    ]);
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
