import * as ExcelJS from 'exceljs';
import { InventoryPinExcelParser } from './inventory.pin.excel.parser';

/** 시트 2차원 배열을 그대로 xlsx 버퍼로 만든다. */
async function buildXlsx(rows: unknown[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('PIN');
  rows.forEach((row) => sheet.addRow(row as ExcelJS.CellValue[]));
  return (await workbook.xlsx.writeBuffer()) as Buffer;
}

describe('InventoryPinExcelParser', () => {
  const parser = new InventoryPinExcelParser();

  it('확정 양식(코드/유효기간) 2열을 파싱한다', async () => {
    const buffer = await buildXlsx([
      ['코드', '유효기간'],
      ['VSREET2RJQXCA2', '2027-12-31'],
      ['ABCD1234EFGH5678', '2027.01.05'],
    ]);

    const { rows, errors } = await parser.parse(buffer);

    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { rowNumber: 2, primaryCode: 'VSREET2RJQXCA2', secondaryCode: null, productCode: null, expiresOn: '2027-12-31' },
      {
        rowNumber: 3,
        primaryCode: 'ABCD1234EFGH5678',
        secondaryCode: null,
        productCode: null,
        expiresOn: '2027-01-05',
      },
    ]);
  });

  it('영문 헤더/대소문자/공백 표기도 같은 열로 인식한다', async () => {
    const buffer = await buildXlsx([
      [' Claim Code ', 'Expires On'],
      ['CODE-1', '20271231'],
    ]);

    const { rows } = await parser.parse(buffer);

    expect(rows[0]).toMatchObject({ primaryCode: 'CODE-1', expiresOn: '2027-12-31' });
  });

  it('날짜 셀(Date)은 하루 밀림 없이 그 날짜로 읽는다', async () => {
    const buffer = await buildXlsx([
      ['코드', '유효기간'],
      ['CODE-1', new Date(Date.UTC(2027, 11, 31))],
    ]);

    const { rows } = await parser.parse(buffer);

    expect(rows[0].expiresOn).toBe('2027-12-31');
  });

  it('유효기간이 비면 무기한(null)', async () => {
    const buffer = await buildXlsx([
      ['코드', '유효기간'],
      ['CODE-1', null],
    ]);

    const { rows, errors } = await parser.parse(buffer);

    expect(errors).toEqual([]);
    expect(rows[0].expiresOn).toBeNull();
  });

  it('해석 불가 유효기간은 행 오류로 올리고 그 행을 제외한다', async () => {
    const buffer = await buildXlsx([
      ['코드', '유효기간'],
      ['CODE-1', '내년까지'],
      ['CODE-2', '2027-13-45'],
      ['CODE-3', '2027-12-31'],
    ]);

    const { rows, errors } = await parser.parse(buffer);

    expect(rows.map((r) => r.primaryCode)).toEqual(['CODE-3']);
    expect(errors).toEqual([
      { rowNumber: 2, field: 'expiresOn', errorCode: 'INVALID_FORMAT' },
      { rowNumber: 3, field: 'expiresOn', errorCode: 'INVALID_FORMAT' },
    ]);
  });

  it('빈 행은 건너뛰고, 코드만 빈 행은 오류로 올린다 (행 번호는 엑셀 실제 행)', async () => {
    const buffer = await buildXlsx([
      ['코드', '유효기간'],
      ['CODE-1', '2027-12-31'],
      [null, null],
      [null, '2027-12-31'],
      ['CODE-2', '2027-12-31'],
    ]);

    const { rows, errors } = await parser.parse(buffer);

    expect(rows.map((r) => r.rowNumber)).toEqual([2, 5]);
    expect(errors).toEqual([{ rowNumber: 4, field: 'primaryCode', errorCode: 'REQUIRED' }]);
  });

  it('제목 행이 위에 있어도 헤더 행을 찾는다', async () => {
    const buffer = await buildXlsx([
      ['2026년 8월 아마존 기프트카드 입고분'],
      [],
      ['코드', '유효기간'],
      ['CODE-1', '2027-12-31'],
    ]);

    const { rows } = await parser.parse(buffer);

    expect(rows).toHaveLength(1);
    expect(rows[0].rowNumber).toBe(4);
  });

  it('유효기간 헤더가 없으면 무기한으로 들이지 않고 파일을 반려한다', async () => {
    const buffer = await buildXlsx([['코드'], ['CODE-1']]);

    await expect(parser.parse(buffer)).rejects.toThrow("'유효기간' 열을 찾지 못했습니다");
  });

  it('숫자 셀 코드는 선행 0/정밀도 손실 때문에 받지 않는다', async () => {
    const buffer = await buildXlsx([
      ['코드', '유효기간'],
      [1234567890123456, '2027-12-31'],
    ]);

    const { rows, errors } = await parser.parse(buffer);

    expect(rows).toEqual([]);
    expect(errors).toEqual([{ rowNumber: 2, field: 'primaryCode', errorCode: 'NUMERIC_CELL' }]);
  });

  it('수식 오류 셀은 [object Object] 로 등록되지 않고 행 오류로 막는다', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('PIN');
    sheet.addRow(['코드', '유효기간']);
    sheet.getCell('A2').value = { formula: 'VLOOKUP(1,A:A,1,0)', error: '#N/A' } as unknown as ExcelJS.CellValue;
    sheet.getCell('B2').value = '2027-12-31';

    const { rows, errors } = await parser.parse((await workbook.xlsx.writeBuffer()) as Buffer);

    expect(rows).toEqual([]);
    expect(errors).toEqual([{ rowNumber: 2, field: 'primaryCode', errorCode: 'INVALID_CELL' }]);
  });

  it('수식 결과 문자열은 그대로 쓴다', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('PIN');
    sheet.addRow(['코드', '유효기간']);
    sheet.getCell('A2').value = { formula: 'CONCAT(...)', result: 'CODE-1' } as ExcelJS.CellFormulaValue;
    sheet.getCell('B2').value = '2027-12-31';

    const { rows, errors } = await parser.parse((await workbook.xlsx.writeBuffer()) as Buffer);

    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ primaryCode: 'CODE-1', expiresOn: '2027-12-31' });
  });

  it('행 상한은 오류 행까지 포함해 센다', async () => {
    const limit = InventoryPinExcelParser.MAX_ROWS;
    const sheet: unknown[][] = [['코드', '유효기간']];
    // 전부 오류 행(코드 비어 있음)이어도 상한을 넘기면 파일을 받지 않는다.
    for (let i = 0; i < limit + 1; i++) sheet.push([null, '2027-12-31']);

    await expect(parser.parse(await buildXlsx(sheet))).rejects.toThrow('나눠 업로드');
  });

  it('선택 열(보조코드/상품코드)이 있으면 함께 읽는다', async () => {
    const buffer = await buildXlsx([
      ['상품코드', '코드', '보조코드', '유효기간'],
      ['1234', 'CODE-1', 'S-1', '2027-12-31'],
    ]);

    const { rows } = await parser.parse(buffer);

    expect(rows[0]).toMatchObject({ productCode: '1234', primaryCode: 'CODE-1', secondaryCode: 'S-1' });
  });

  it('코드 열이 없으면 양식 오류로 반려한다', async () => {
    const buffer = await buildXlsx([
      ['이름', '수량'],
      ['아마존', 10],
    ]);

    await expect(parser.parse(buffer)).rejects.toThrow("'코드', '유효기간'");
  });

  it('데이터 행이 하나도 없으면 반려한다', async () => {
    const buffer = await buildXlsx([['코드', '유효기간']]);

    await expect(parser.parse(buffer)).rejects.toThrow('등록할 PIN 행이 없습니다.');
  });

  it('xlsx 가 아니면 읽기 실패로 반려한다', async () => {
    await expect(parser.parse(Buffer.from('not an excel file'))).rejects.toThrow('엑셀 파일');
  });
});
