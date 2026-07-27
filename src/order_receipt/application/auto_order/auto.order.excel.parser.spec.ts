import * as ExcelJS from 'exceljs';
import { AutoOrderExcelParser } from './auto.order.excel.parser';
import { AutoOrderStructureValidator } from './auto.order.structure.validator';
import { IOrderSendMethod } from '../../../order/interface/order.send.method';

/**
 * 실물 v4.1 양식은 J(수량)/M(_유효)/N(_상태)/H(상품코드)가 "수식 + 캐시결과" 셀이다.
 * 엑셀이 저장 시 결과를 캐시한 상태를 모사해(= {formula, result}), 파서가 result를 정확히 꺼내는지 검증한다.
 */
async function buildBuffer(opts: {
  formVersion?: string;
  immediate?: string;
  sendMethod?: string;
  eventName?: string;
  sendTitle?: string;
  sendContent?: string;
  withRows?: boolean;
  sendDate?: unknown; // C17 (문자열/Date/빈값 등 다양한 케이스)
  sendTime?: unknown; // C18 (문자열/Date/빈값 등 다양한 케이스)
  destroyDay?: unknown; // C25
}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const info = wb.addWorksheet('1.신청정보');
  info.getCell('C1').value = opts.formVersion ?? 'v4.1-immediate-send';
  info.getCell('C16').value = opts.immediate ?? 'FALSE';
  info.getCell('C17').value = (opts.sendDate ?? '2026-08-05') as ExcelJS.CellValue;
  info.getCell('C18').value = (opts.sendTime ?? '14:30') as ExcelJS.CellValue;
  info.getCell('C19').value = opts.eventName ?? '8월 프로모션';
  info.getCell('C20').value = opts.sendTitle ?? '여름 이벤트 쿠폰';
  info.getCell('C21').value = opts.sendContent ?? '즐거운 여름 되세요';
  info.getCell('C23').value = opts.sendMethod ?? '문자';
  info.getCell('C24').value = '1644-3614';
  info.getCell('C25').value = (opts.destroyDay ?? 90) as ExcelJS.CellValue;

  const list = wb.addWorksheet('2.발송명단');
  if (opts.withRows !== false) {
    const f = (formula: string, result: unknown) => ({ formula, result }) as ExcelJS.CellFormulaValue;
    // 행5: 정상
    list.getCell('B5').value = '010-1111-2222';
    list.getCell('D5').value = 'a@x.com';
    list.getCell('H5').value = f('INDEX(...)', 'SB-5000-90');
    list.getCell('J5').value = f('IF(B5="","",1)', 1);
    list.getCell('M5').value = f('AND(...)', true);
    list.getCell('N5').value = f('IF(...)', 'ok');
    list.getCell('P5').value = '홍길동';
    // 행6: 무효(M=false)
    list.getCell('B6').value = '010-3333-4444';
    list.getCell('H6').value = f('INDEX(...)', 'ED-4000-60');
    list.getCell('J6').value = f('IF(B6="","",1)', 1);
    list.getCell('M6').value = f('AND(...)', false);
    list.getCell('N6').value = f('IF(...)', 'duplicate');
  }
  return (await wb.xlsx.writeBuffer()) as Buffer;
}

describe('AutoOrderExcelParser', () => {
  const parser = new AutoOrderExcelParser();

  it('신청정보 헤더를 정확히 파싱한다 (C열, 한글 발신수단, KST 시각)', async () => {
    const parsed = await parser.parse(await buildBuffer({}));
    const h = parsed.header!;
    expect(parsed.parseError).toBeNull();
    expect(h.formVersion).toBe('v4.1-immediate-send');
    expect(h.eventName).toBe('8월 프로모션');
    expect(h.sendMethod).toBe(IOrderSendMethod.MMS); // 문자 → MMS
    expect(h.isImmediate).toBe(false);
    expect(h.destroyDay).toBe(90);
    // KST 14:30 = UTC 05:30
    expect(h.sendRequestAt?.toISOString()).toBe('2026-08-05T05:30:00.000Z');
  });

  it('수식 셀(J/M/N/H)의 캐시결과를 꺼낸다', async () => {
    const parsed = await parser.parse(await buildBuffer({}));
    expect(parsed.rows).toHaveLength(2);

    const [r5, r6] = parsed.rows;
    expect(r5.rowNo).toBe(5); // 엑셀 행번호 보존
    expect(r5.productCode).toBe('SB-5000-90'); // H 수식결과
    expect(r5.amount).toBe(1); // J 수식결과(숫자)
    expect(r5.isValid).toBe(true); // M 수식결과(불리언 true)
    expect(r5.statusReason).toBe('ok'); // N 수식결과
    expect(r5.replaceCharacter1).toBe('홍길동');

    expect(r6.isValid).toBe(false); // M false
    expect(r6.statusReason).toBe('duplicate');
    expect(r6.email).toBeNull();
  });

  it('즉시발송이면 sendRequestAt은 null', async () => {
    const parsed = await parser.parse(await buildBuffer({ immediate: 'TRUE' }));
    expect(parsed.header!.isImmediate).toBe(true);
    expect(parsed.header!.sendRequestAt).toBeNull();
  });

  it('알 수 없는 발신수단은 null로 파싱', async () => {
    const parsed = await parser.parse(await buildBuffer({ sendMethod: '카카오' }));
    expect(parsed.header!.sendMethod).toBeNull();
  });

  // ── 리뷰 반영: toKstDate 하드닝 (조용한 자정 폴백 금지 + 네이티브 시간셀 + 범위검증)
  it('자정 경계: 00:00 KST → 전날 UTC 15:00', async () => {
    const parsed = await parser.parse(await buildBuffer({ sendTime: '00:00' }));
    expect(parsed.header!.sendRequestAt?.toISOString()).toBe('2026-08-04T15:00:00.000Z');
  });

  it('한 자리 시(9:30)도 파싱', async () => {
    const parsed = await parser.parse(await buildBuffer({ sendTime: '9:30' }));
    expect(parsed.header!.sendRequestAt?.toISOString()).toBe('2026-08-05T00:30:00.000Z');
  });

  it('네이티브 시간셀(Date)도 흡수 (조용한 자정 폴백 아님)', async () => {
    // 엑셀이 시간을 native Date로 저장 → cell()이 ISO로 변환 → 시간부 추출
    const parsed = await parser.parse(await buildBuffer({ sendTime: new Date('2026-08-05T14:30:00.000Z') }));
    // ISO의 시각(14:30)을 KST로 재조합 → UTC 05:30
    expect(parsed.header!.sendRequestAt?.toISOString()).toBe('2026-08-05T05:30:00.000Z');
  });

  it('범위 초과 시간(25:99)은 null (자정으로 조용히 안 떨어짐)', async () => {
    const parsed = await parser.parse(await buildBuffer({ sendTime: '25:99' }));
    expect(parsed.header!.sendRequestAt).toBeNull();
  });

  it('빈 시간 + 예약발송은 null', async () => {
    const parsed = await parser.parse(await buildBuffer({ sendTime: '', immediate: 'FALSE' }));
    expect(parsed.header!.sendRequestAt).toBeNull();
  });

  // ── 리뷰 반영(PR#7): 존재하지 않는 달력 날짜가 롤오버로 정상 예약발송으로 둔갑하는 것 차단
  it.each(['2026-02-30', '2026-02-31', '2026-04-31', '2026-06-31', '2026-13-01', '2026-00-10', '2026-01-32'])(
    '실재하지 않는 달력 날짜(%s)는 null (롤오버 둔갑 금지)',
    async (badDate) => {
      const parsed = await parser.parse(await buildBuffer({ sendDate: badDate }));
      expect(parsed.header!.sendRequestAt).toBeNull();
    },
  );

  it('평년 2월 29일(2026-02-29)은 null', async () => {
    const parsed = await parser.parse(await buildBuffer({ sendDate: '2026-02-29' }));
    expect(parsed.header!.sendRequestAt).toBeNull();
  });

  it('윤년 2월 29일(2028-02-29)은 정상 파싱', async () => {
    const parsed = await parser.parse(await buildBuffer({ sendDate: '2028-02-29' }));
    // 기본 sendTime '14:30' KST = UTC 05:30
    expect(parsed.header!.sendRequestAt?.toISOString()).toBe('2028-02-29T05:30:00.000Z');
  });

  // 롤오버 가드가 실재하는 말일(30/31일)을 오검출하지 않는지 — 정상 예약발송을 막으면 안 됨
  it.each([
    ['2026-01-31', '2026-01-31T05:30:00.000Z'], // 31일 달 말일
    ['2026-04-30', '2026-04-30T05:30:00.000Z'], // 30일 달 말일(31일이면 롤오버)
    ['2026-02-28', '2026-02-28T05:30:00.000Z'], // 평년 2월 말일
    ['2026-12-31', '2026-12-31T05:30:00.000Z'], // 연말 경계
  ])('실재하는 말일(%s)은 정상 파싱(가드 오검출 없음)', async (date, iso) => {
    const parsed = await parser.parse(await buildBuffer({ sendDate: date }));
    expect(parsed.header!.sendRequestAt?.toISOString()).toBe(iso);
  });

  it('즉시발송이면 날짜가 불량(2026-02-30)이어도 sendRequestAt은 null(날짜 미사용 → 가드 비켜감)', async () => {
    const parsed = await parser.parse(await buildBuffer({ immediate: 'TRUE', sendDate: '2026-02-30' }));
    expect(parsed.header!.isImmediate).toBe(true);
    expect(parsed.header!.sendRequestAt).toBeNull();
  });

  // ── 리뷰 반영(Finding E): 즉시발송 여부(C16)를 'TRUE' 한 토큰이 아니라 명시 참/거짓 집합으로 해석, 모호값은 null
  it.each(['예', '즉시', '즉시발송', '1', 'Y', 'true'])('즉시발송 참 토큰(%s) → isImmediate=true', async (v) => {
    const parsed = await parser.parse(await buildBuffer({ immediate: v }));
    expect(parsed.header!.isImmediate).toBe(true);
  });

  it.each(['예약', '예약발송', '0', 'N', 'false'])('즉시발송 거짓 토큰(%s) → isImmediate=false', async (v) => {
    const parsed = await parser.parse(await buildBuffer({ immediate: v }));
    expect(parsed.header!.isImmediate).toBe(false);
  });

  it.each(['', '체크', 'maybe', '즉시발송요망'])('알 수 없는 C16 값(%s) → isImmediate=null (조용한 예약 둔갑 금지)', async (v) => {
    const parsed = await parser.parse(await buildBuffer({ immediate: v }));
    expect(parsed.header!.isImmediate).toBeNull();
  });

  // ── 리뷰 반영(Finding B): 계산 없이 저장된 파일(신뢰 수식 캐시가 전무)은 신뢰 불가 → FORMULA_NOT_CACHED
  it('신뢰 수식(H/J/M)이 전부 결과 미캐시면 parseError=FORMULA_NOT_CACHED', async () => {
    const wb = new ExcelJS.Workbook();
    const info = wb.addWorksheet('1.신청정보');
    info.getCell('C1').value = 'v4.1-immediate-send';
    info.getCell('C16').value = 'FALSE';
    info.getCell('C19').value = '이벤트';
    const list = wb.addWorksheet('2.발송명단');
    list.getCell('B5').value = '010-1111-2222';
    // 수식만 있고 결과 캐시 없음(계산 없이 저장) — H/J/M 전부
    list.getCell('H5').value = { formula: 'INDEX(...)' } as unknown as ExcelJS.CellValue;
    list.getCell('J5').value = { formula: 'IF(...)' } as unknown as ExcelJS.CellValue;
    list.getCell('M5').value = { formula: 'AND(...)' } as unknown as ExcelJS.CellValue;
    const parsed = await parser.parse((await wb.xlsx.writeBuffer()) as Buffer);
    expect(parsed.parseError).toBe('FORMULA_NOT_CACHED');
  });

  it('일부라도 캐시된 신뢰 수식이 있으면(정상) parseError=null — M=false 정상 제외행 오탐 없음', async () => {
    // 기본 fixture는 M6=false(엑셀이 falsy 캐시를 생략)지만 M5=true가 캐시돼 있어 미캐시 파일이 아니다.
    const parsed = await parser.parse(await buildBuffer({}));
    expect(parsed.parseError).toBeNull();
    expect(parsed.rows[1].isValid).toBe(false); // M=false 정상 인식
  });

  it('H/J는 캐시됐어도 M(_유효)만 미캐시면 FORMULA_NOT_CACHED (M-한정 판정)', async () => {
    const wb = new ExcelJS.Workbook();
    const info = wb.addWorksheet('1.신청정보');
    info.getCell('C1').value = 'v4.1-immediate-send';
    info.getCell('C16').value = 'FALSE';
    info.getCell('C19').value = '이벤트';
    const list = wb.addWorksheet('2.발송명단');
    list.getCell('B5').value = '010-1111-2222';
    list.getCell('H5').value = { formula: 'INDEX(...)', result: 'SB-5000-90' } as ExcelJS.CellFormulaValue; // 캐시됨
    list.getCell('J5').value = { formula: 'IF(...)', result: 1 } as ExcelJS.CellFormulaValue; // 캐시됨
    list.getCell('M5').value = { formula: 'AND(...)' } as unknown as ExcelJS.CellValue; // M만 미캐시
    const parsed = await parser.parse((await wb.xlsx.writeBuffer()) as Buffer);
    expect(parsed.parseError).toBe('FORMULA_NOT_CACHED');
  });

  // ── 리뷰 반영: richText/하이퍼링크 셀에서도 평문을 복원
  it('richText 헤더 + 하이퍼링크 이메일 셀에서 평문을 꺼낸다', async () => {
    const wb = new ExcelJS.Workbook();
    const info = wb.addWorksheet('1.신청정보');
    info.getCell('C1').value = 'v4.1-immediate-send';
    info.getCell('C16').value = 'TRUE';
    info.getCell('C19').value = { richText: [{ text: '8월 ' }, { text: '프로모션' }] } as ExcelJS.CellValue;
    const list = wb.addWorksheet('2.발송명단');
    list.getCell('D5').value = { text: 'a@x.com', hyperlink: 'mailto:a@x.com' } as ExcelJS.CellValue;
    list.getCell('J5').value = { formula: 'IF(...)', result: 0 } as ExcelJS.CellFormulaValue;
    list.getCell('M5').value = { formula: 'AND(...)', result: true } as ExcelJS.CellFormulaValue;
    const parsed = await parser.parse((await wb.xlsx.writeBuffer()) as Buffer);
    expect(parsed.header!.eventName).toBe('8월 프로모션');
    expect(parsed.rows[0].email).toBe('a@x.com');
  });

  // ── 리뷰 반영: 이메일 전용 행(B 없음, D 있음)은 빈 행 스킵에 걸리지 않는다
  it('이메일 전용 행(휴대폰 없음)은 스킵되지 않고 보존', async () => {
    const wb = new ExcelJS.Workbook();
    const info = wb.addWorksheet('1.신청정보');
    info.getCell('C1').value = 'v4.1-immediate-send';
    info.getCell('C16').value = 'TRUE';
    const list = wb.addWorksheet('2.발송명단');
    list.getCell('D5').value = 'only@mail.com';
    list.getCell('H5').value = { formula: 'INDEX(...)', result: 'SB-5000-90' } as ExcelJS.CellFormulaValue;
    list.getCell('J5').value = { formula: 'IF(...)', result: 0 } as ExcelJS.CellFormulaValue;
    list.getCell('M5').value = { formula: 'AND(...)', result: true } as ExcelJS.CellFormulaValue;
    const parsed = await parser.parse((await wb.xlsx.writeBuffer()) as Buffer);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].phone).toBeNull();
    expect(parsed.rows[0].email).toBe('only@mail.com');
  });

  // ── 리뷰 반영(M2): 상품코드는 있고 연락처(B/D)만 빈 행은 스킵되지 않고 보존(하류 MISSING_DELIVERY_TARGET 집계용)
  it('상품코드 있고 연락처 없는 행은 스킵되지 않고 보존(silent drop 방지)', async () => {
    const wb = new ExcelJS.Workbook();
    const info = wb.addWorksheet('1.신청정보');
    info.getCell('C1').value = 'v4.1-immediate-send';
    info.getCell('C16').value = 'TRUE';
    const list = wb.addWorksheet('2.발송명단');
    list.getCell('H5').value = { formula: 'INDEX(...)', result: 'SB-5000-90' } as ExcelJS.CellFormulaValue;
    list.getCell('M5').value = { formula: 'AND(...)', result: true } as ExcelJS.CellFormulaValue;
    const parsed = await parser.parse((await wb.xlsx.writeBuffer()) as Buffer);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].phone).toBeNull();
    expect(parsed.rows[0].email).toBeNull();
    expect(parsed.rows[0].productCode).toBe('SB-5000-90'); // 검산/차단이 볼 수 있게 보존
  });

  // ── 연락처·상품코드 모두 없는 진짜 빈 행은 계속 스킵(대치문자만 있어도 주문 불가)
  it('연락처·상품코드 모두 없는 행은 스킵(빈 행)', async () => {
    const wb = new ExcelJS.Workbook();
    const info = wb.addWorksheet('1.신청정보');
    info.getCell('C1').value = 'v4.1-immediate-send';
    info.getCell('C16').value = 'TRUE';
    const list = wb.addWorksheet('2.발송명단');
    list.getCell('P5').value = '홍길동'; // 대치문자만 있고 상품/연락처 없음
    const parsed = await parser.parse((await wb.xlsx.writeBuffer()) as Buffer);
    expect(parsed.rows).toHaveLength(0);
  });

  // ── 리뷰 반영: 필수 시트 누락 → SHEET_MISSING
  it('발송명단 시트가 없으면 parseError=SHEET_MISSING, header=null', async () => {
    const wb = new ExcelJS.Workbook();
    const info = wb.addWorksheet('1.신청정보');
    info.getCell('C1').value = 'v4.1-immediate-send';
    const parsed = await parser.parse((await wb.xlsx.writeBuffer()) as Buffer);
    expect(parsed.parseError).toBe('SHEET_MISSING');
    expect(parsed.header).toBeNull();
  });
});

describe('AutoOrderStructureValidator', () => {
  const parser = new AutoOrderExcelParser();
  const validator = new AutoOrderStructureValidator();

  it('정상 양식은 VALID', async () => {
    const parsed = await parser.parse(await buildBuffer({}));
    expect(validator.validate(parsed).status).toBe('VALID');
  });

  it('지원하지 않는 양식버전은 INVALID_FORMAT', async () => {
    const parsed = await parser.parse(await buildBuffer({ formVersion: 'v3.9' }));
    const r = validator.validate(parsed);
    expect(r.status).toBe('INVALID_FORMAT');
    expect(r.message).toContain('양식버전');
  });

  it('프로모션명 비면 INVALID_FORMAT', async () => {
    const parsed = await parser.parse(await buildBuffer({ eventName: '' }));
    expect(validator.validate(parsed).status).toBe('INVALID_FORMAT');
  });

  it('발송 제목(C20) 비면 INVALID_FORMAT', async () => {
    const parsed = await parser.parse(await buildBuffer({ sendTitle: '' }));
    const r = validator.validate(parsed);
    expect(r.status).toBe('INVALID_FORMAT');
    expect(r.message).toContain('발송 제목');
  });

  it('발송 내용(C21) 비면 INVALID_FORMAT', async () => {
    const parsed = await parser.parse(await buildBuffer({ sendContent: '' }));
    const r = validator.validate(parsed);
    expect(r.status).toBe('INVALID_FORMAT');
    expect(r.message).toContain('발송 내용');
  });

  it('발송명단 데이터 0건이면 INVALID_FORMAT', async () => {
    const parsed = await parser.parse(await buildBuffer({ withRows: false }));
    const r = validator.validate(parsed);
    expect(r.status).toBe('INVALID_FORMAT');
    expect(r.message).toContain('발송명단');
  });

  // ── 리뷰 반영: destroyDay 불량(0) 및 예약발송 시간 불량 리젝
  it('파기일(C25)이 0/불량이면 INVALID_FORMAT', async () => {
    const parsed = await parser.parse(await buildBuffer({ destroyDay: '' }));
    const r = validator.validate(parsed);
    expect(r.status).toBe('INVALID_FORMAT');
    expect(r.message).toContain('파기일');
  });

  it('예약발송인데 시간이 불량(25:99)이면 INVALID_FORMAT (자정 폴백 아님)', async () => {
    const parsed = await parser.parse(await buildBuffer({ sendTime: '25:99', immediate: 'FALSE' }));
    const r = validator.validate(parsed);
    expect(r.status).toBe('INVALID_FORMAT');
    expect(r.message).toContain('발송희망일/시간');
  });

  it('예약발송인데 날짜가 실재하지 않으면(2026-02-30) INVALID_FORMAT (롤오버 둔갑 아님)', async () => {
    const parsed = await parser.parse(await buildBuffer({ sendDate: '2026-02-30', immediate: 'FALSE' }));
    const r = validator.validate(parsed);
    expect(r.status).toBe('INVALID_FORMAT');
    expect(r.message).toContain('발송희망일/시간');
  });

  it('즉시발송이면 날짜가 불량(2026-02-30)이어도 VALID (날짜 검증 대상 아님)', async () => {
    const parsed = await parser.parse(await buildBuffer({ sendDate: '2026-02-30', immediate: 'TRUE' }));
    expect(validator.validate(parsed).status).toBe('VALID');
  });

  it('알 수 없는 발신수단(카카오)은 INVALID_FORMAT', async () => {
    const parsed = await parser.parse(await buildBuffer({ sendMethod: '카카오' }));
    const r = validator.validate(parsed);
    expect(r.status).toBe('INVALID_FORMAT');
    expect(r.message).toContain('발신수단');
  });

  it('즉시발송 여부(C16)가 해석불가면 INVALID_FORMAT', async () => {
    const parsed = await parser.parse(await buildBuffer({ immediate: '체크박스' }));
    const r = validator.validate(parsed);
    expect(r.status).toBe('INVALID_FORMAT');
    expect(r.message).toContain('즉시발송 여부');
  });

  it('수식 결과 미캐시(FORMULA_NOT_CACHED)면 INVALID_FORMAT', async () => {
    const parsed: any = { header: { formVersion: 'v4.1-immediate-send' }, rows: [], parseError: 'FORMULA_NOT_CACHED' };
    const r = validator.validate(parsed);
    expect(r.status).toBe('INVALID_FORMAT');
    expect(r.message).toContain('수식');
  });

  it('필수 시트 누락(SHEET_MISSING)이면 INVALID_FORMAT', async () => {
    const parsed: any = { header: null, rows: [], parseError: 'SHEET_MISSING' };
    const r = validator.validate(parsed);
    expect(r.status).toBe('INVALID_FORMAT');
    expect(r.message).toContain('필수 시트');
  });

  it('행수 상한 초과(TOO_MANY_ROWS)면 INVALID_FORMAT (처리 한도 안내)', () => {
    const parsed: any = { header: { formVersion: 'v4.1-immediate-send' }, rows: [], parseError: 'TOO_MANY_ROWS' };
    const r = validator.validate(parsed);
    expect(r.status).toBe('INVALID_FORMAT');
    expect(r.message).toContain('한도');
  });
});
