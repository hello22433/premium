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
  withRows?: boolean;
}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const info = wb.addWorksheet('1.신청정보');
  info.getCell('C1').value = opts.formVersion ?? 'v4.1-immediate-send';
  info.getCell('C16').value = opts.immediate ?? 'FALSE';
  info.getCell('C17').value = '2026-08-05';
  info.getCell('C18').value = '14:30';
  info.getCell('C19').value = opts.eventName ?? '8월 프로모션';
  info.getCell('C20').value = '여름 이벤트 쿠폰';
  info.getCell('C21').value = '즐거운 여름 되세요';
  info.getCell('C23').value = opts.sendMethod ?? '문자';
  info.getCell('C24').value = '1644-3614';
  info.getCell('C25').value = 90;

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

  it('발송명단 데이터 0건이면 INVALID_FORMAT', async () => {
    const parsed = await parser.parse(await buildBuffer({ withRows: false }));
    const r = validator.validate(parsed);
    expect(r.status).toBe('INVALID_FORMAT');
    expect(r.message).toContain('발송명단');
  });
});
