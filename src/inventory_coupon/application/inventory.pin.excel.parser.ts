import { BadRequestException, Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { ImportRowInput, ImportRowError } from './inventory.pin.import.service';
import { INVALID_EXPIRES_ON, normalizeExpiresOn } from '../domain/inventory.pin.expires';

type ParsedColumns = {
  primaryCode: number;
  expiresOn: number;
  secondaryCode: number;
  productCode: number;
};

/**
 * 코드 계열 셀 읽기 결과.
 *
 * PIN 은 그대로 고객에게 나가는 값이라 "대충 문자열로 변환"하면 안 된다.
 * 숫자 셀은 선행 0 손실·정밀도 손실이 눈에 보이지 않고, 수식 오류 셀은
 * `[object Object]` 가 PIN 으로 등록된다. 그래서 텍스트 셀만 통과시킨다.
 */
type CodeCell =
  | { kind: 'empty' }
  | { kind: 'text'; value: string }
  | { kind: 'unsafe'; errorCode: 'NUMERIC_CELL' | 'INVALID_CELL' };

/**
 * PIN 입고 엑셀 파서. rev5 §6.1.
 *
 * 확정 양식(이커머스 협의, 2026-08-14): **코드 / 유효기간** 2열.
 * 두 헤더가 모두 있어야 파일을 받는다. 유효기간 헤더가 없는 파일을 받아주면
 * 전 행이 조용히 무기한 PIN 으로 등록된다.
 * 상품은 업로드 화면에서 고르므로 파일에 상품 열은 요구하지 않는다(있으면 대조만).
 *
 * PIN 원문은 이 파서가 만든 메모리 배열 밖으로 나가지 않는다.
 * 파일 버퍼도 디스크에 쓰지 않고(memory storage) 호출부에서 즉시 폐기한다.
 */
@Injectable()
export class InventoryPinExcelParser {
  /** 헤더 이후 데이터 행 상한. 오류 행도 포함해서 센다. */
  static readonly MAX_ROWS = 20000;

  /** 헤더 행 탐색 범위. 공급사 파일이 제목/공지 행을 위에 붙이는 경우가 있다. */
  private static readonly HEADER_SCAN_ROWS = 10;

  private static readonly ALIASES: Record<keyof ParsedColumns, string[]> = {
    primaryCode: [
      '코드',
      'pin',
      'pin코드',
      'pin번호',
      '핀',
      '핀코드',
      '핀번호',
      'code',
      'claimcode',
      'gift카드코드',
      'primarycode',
      '쿠폰코드',
    ],
    expiresOn: [
      '유효기간',
      '유효기한',
      '유효종료일',
      '만료일',
      '만료일자',
      '사용기한',
      'expireson',
      'expiredate',
      'expirydate',
      'validend',
      'validenddate',
    ],
    secondaryCode: ['보조코드', '보조번호', 'pin2', '코드2', 'secondarycode', 'securitycode', 'pincode2'],
    productCode: ['상품코드', '상품id', 'productcode', 'productid'],
  };

  /**
   * @param buffer 업로드 원본 xlsx 바이트
   * @returns 입고 서비스에 그대로 넘길 행 배열과, 행 단위 파싱 오류
   */
  async parse(buffer: Buffer): Promise<{ rows: ImportRowInput[]; errors: ImportRowError[] }> {
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(buffer);
    } catch {
      throw new BadRequestException('엑셀 파일을 읽을 수 없습니다. .xlsx 형식인지 확인해주세요.');
    }

    const sheet = workbook.worksheets[0];
    if (!sheet) throw new BadRequestException('엑셀에 시트가 없습니다.');

    const header = this.findHeader(sheet);

    const rows: ImportRowInput[] = [];
    const errors: ImportRowError[] = [];
    let dataRowCount = 0;

    for (let rowNumber = header.rowNumber + 1; rowNumber <= sheet.rowCount; rowNumber++) {
      const row = sheet.getRow(rowNumber);

      const primary = this.readCode(row, header.columns.primaryCode);
      const secondary = this.readCode(row, header.columns.secondaryCode);
      const product = this.readCode(row, header.columns.productCode);
      const rawExpires = this.readRaw(row, header.columns.expiresOn);

      // 모든 열이 비었으면 빈 행 → 행 수에도 넣지 않는다.
      if (primary.kind === 'empty' && secondary.kind === 'empty' && product.kind === 'empty' && rawExpires === null) {
        continue;
      }

      dataRowCount += 1;
      if (dataRowCount > InventoryPinExcelParser.MAX_ROWS) {
        throw new BadRequestException(
          `한 번에 등록할 수 있는 PIN 은 ${InventoryPinExcelParser.MAX_ROWS.toLocaleString()}건입니다. 파일을 나눠 업로드해주세요.`,
        );
      }

      // 값으로 쓸 수 없는 셀(숫자·날짜·수식 오류)은 그 행을 통째로 막는다.
      if (primary.kind === 'unsafe') {
        errors.push({ rowNumber, field: 'primaryCode', errorCode: primary.errorCode });
        continue;
      }
      if (secondary.kind === 'unsafe') {
        errors.push({ rowNumber, field: 'secondaryCode', errorCode: secondary.errorCode });
        continue;
      }
      if (product.kind === 'unsafe') {
        errors.push({ rowNumber, field: 'productCode', errorCode: product.errorCode });
        continue;
      }

      if (primary.kind === 'empty') {
        errors.push({ rowNumber, field: 'primaryCode', errorCode: 'REQUIRED' });
        continue;
      }

      const expiresOn = normalizeExpiresOn(rawExpires);
      if (expiresOn === INVALID_EXPIRES_ON) {
        errors.push({ rowNumber, field: 'expiresOn', errorCode: 'INVALID_FORMAT' });
        continue;
      }

      rows.push({
        rowNumber,
        primaryCode: primary.value,
        secondaryCode: secondary.kind === 'text' ? secondary.value : null,
        productCode: product.kind === 'text' ? product.value : null,
        expiresOn,
      });
    }

    if (rows.length === 0 && errors.length === 0) {
      throw new BadRequestException('등록할 PIN 행이 없습니다.');
    }

    return { rows, errors };
  }

  /**
   * 헤더 행과 열 위치. **코드와 유효기간 두 열이 모두** 있어야 헤더로 인정한다.
   * 하나라도 없으면 양식이 다른 파일이므로 행을 하나도 만들지 않고 반려한다.
   */
  private findHeader(sheet: ExcelJS.Worksheet): { rowNumber: number; columns: ParsedColumns } {
    const lastScanRow = Math.min(sheet.rowCount, InventoryPinExcelParser.HEADER_SCAN_ROWS);
    let bestMatch: ParsedColumns | null = null;

    for (let rowNumber = 1; rowNumber <= lastScanRow; rowNumber++) {
      const row = sheet.getRow(rowNumber);
      const columns: ParsedColumns = { primaryCode: 0, expiresOn: 0, secondaryCode: 0, productCode: 0 };

      for (let col = 1; col <= sheet.columnCount; col++) {
        const key = this.matchColumn(this.headerText(row, col));
        // 같은 뜻의 열이 두 번 나오면 첫 열을 쓴다.
        if (key && !columns[key]) columns[key] = col;
      }

      if (columns.primaryCode && columns.expiresOn) return { rowNumber, columns };
      // 한쪽만 맞은 행은 오류 메시지에서 "무엇이 빠졌는지" 짚어주는 근거로만 쓴다.
      if (!bestMatch && (columns.primaryCode || columns.expiresOn)) bestMatch = columns;
    }

    const missing: string[] = [];
    if (!bestMatch?.primaryCode) missing.push('코드');
    if (!bestMatch?.expiresOn) missing.push('유효기간');
    throw new BadRequestException(
      `엑셀 헤더에서 '${missing.join("', '")}' 열을 찾지 못했습니다. 양식(코드 / 유효기간)을 확인해주세요.`,
    );
  }

  private matchColumn(headerText: string): keyof ParsedColumns | null {
    const normalized = headerText.toLowerCase().replace(/[\s_\-()[\]]/g, '');
    if (!normalized) return null;

    for (const [key, aliases] of Object.entries(InventoryPinExcelParser.ALIASES)) {
      if (aliases.includes(normalized)) return key as keyof ParsedColumns;
    }
    return null;
  }

  /** 헤더 셀은 표시용 문자열이면 충분하다(코드 셀과 달리 타입 안전성 요구 없음). */
  private headerText(row: ExcelJS.Row, col: number): string {
    const raw = this.readRaw(row, col);
    if (raw === null) return '';
    if (raw instanceof Date) return '';
    return String(raw).trim();
  }

  /** 코드 계열 셀. 텍스트만 통과시키고 숫자/날짜/오류 셀은 사유와 함께 막는다. */
  private readCode(row: ExcelJS.Row, col: number): CodeCell {
    const raw = this.readRaw(row, col);
    if (raw === null) return { kind: 'empty' };

    if (typeof raw === 'string') {
      const value = raw.trim();
      return value ? { kind: 'text', value } : { kind: 'empty' };
    }

    // 숫자 셀은 선행 0/정밀도 손실이 화면에 드러나지 않는다. 텍스트 서식을 요구한다.
    if (typeof raw === 'number') return { kind: 'unsafe', errorCode: 'NUMERIC_CELL' };

    // Date, boolean, 수식 오류(#N/A 등) → 코드가 될 수 없는 값.
    return { kind: 'unsafe', errorCode: 'INVALID_CELL' };
  }

  /**
   * 셀 원시값을 primitive 로 푼다.
   * 수식/리치텍스트/하이퍼링크는 내용을 꺼내고, 수식 오류 객체는 `INVALID_CELL_VALUE` 로 남긴다
   * (문자열로 접으면 `[object Object]` 가 값이 된다).
   */
  private readRaw(row: ExcelJS.Row, col: number): string | number | boolean | Date | typeof INVALID_CELL_VALUE | null {
    if (!col) return null;

    const value = row.getCell(col).value;
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value;

    if (typeof value === 'object') {
      const v = value as {
        result?: unknown;
        error?: unknown;
        richText?: { text: string }[];
        text?: unknown;
      };
      if ('error' in v) return INVALID_CELL_VALUE; // 셀 자체가 #N/A 등 오류
      if ('richText' in v && v.richText) return this.emptyToNull(v.richText.map((t) => t.text).join(''));
      if ('result' in v) return this.unwrapFormulaResult(v.result);
      if ('text' in v) return this.emptyToNull(String(v.text ?? '')); // 하이퍼링크
      return INVALID_CELL_VALUE;
    }

    if (typeof value === 'string') return this.emptyToNull(value);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    return INVALID_CELL_VALUE;
  }

  /** 수식 결과 캐시. 오류 객체·미캐시는 값으로 쓰지 않는다. */
  private unwrapFormulaResult(result: unknown): string | number | boolean | Date | typeof INVALID_CELL_VALUE | null {
    if (result === null || result === undefined) return null;
    if (result instanceof Date) return result;
    if (typeof result === 'string') return this.emptyToNull(result);
    if (typeof result === 'number' || typeof result === 'boolean') return result;
    return INVALID_CELL_VALUE;
  }

  private emptyToNull(value: string): string | null {
    const trimmed = value.replace(/^\uFEFF/, '').trim();
    return trimmed === '' ? null : trimmed;
  }
}

/** 값으로 쓸 수 없는 셀(수식 오류 등) 마커. */
const INVALID_CELL_VALUE = Symbol('INVALID_CELL_VALUE');
