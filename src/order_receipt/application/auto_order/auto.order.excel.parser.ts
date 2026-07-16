import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { IOrderSendMethod } from '../../../order/interface/order.send.method';
import { ParsedFile, ParsedHeader, ParsedRow } from './auto.order.types';

/**
 * 1단계 - 엑셀 파서.
 * "판단"은 하지 않고 셀 값만 꺼낸다(검증은 2단계 구조검증에서).
 * 셀 주소는 v4.1 양식 실물 기준 C열 하드코딩.
 */
@Injectable()
export class AutoOrderExcelParser {
  private static readonly INFO_SHEET = '1.신청정보';
  private static readonly LIST_SHEET = '2.발송명단';
  private static readonly DATA_START_ROW = 5; // 1~4행은 META/헤더/안내

  async parse(buffer: Buffer): Promise<ParsedFile> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    const info = workbook.getWorksheet(AutoOrderExcelParser.INFO_SHEET);
    const list = workbook.getWorksheet(AutoOrderExcelParser.LIST_SHEET);

    // 시트가 없으면 파싱 불가 → 2단계에서 INVALID_FORMAT 처리하도록 신호만 전달
    if (!info || !list) {
      return { header: null, rows: [], parseError: 'SHEET_MISSING' };
    }

    const header = this.parseHeader(info);
    const rows = this.parseRows(list);
    return { header, rows, parseError: null };
  }

  private parseHeader(info: ExcelJS.Worksheet): ParsedHeader {
    const sendDate = this.cell(info, 'C17');
    const sendTime = this.cell(info, 'C18');
    const isImmediate = this.toBool(this.cell(info, 'C16'));

    return {
      formVersion: this.cell(info, 'C1'),
      eventName: this.cell(info, 'C19'),
      sendTitle: this.cell(info, 'C20'),
      sendContent: this.cell(info, 'C21'),
      sendMethod: this.toSendMethod(this.cell(info, 'C23')),
      fromPhoneNumber: this.cell(info, 'C24'),
      isImmediate,
      sendDate,
      sendTime,
      sendRequestAt: isImmediate ? null : this.toKstDate(sendDate, sendTime),
      destroyDay: this.toInt(this.cell(info, 'C25')),
    };
  }

  private parseRows(list: ExcelJS.Worksheet): ParsedRow[] {
    const rows: ParsedRow[] = [];

    // getRow의 rowNumber는 엑셀과 동일한 1-based → 그대로 rowNo로 사용
    list.eachRow({ includeEmpty: false }, (row, rowNo) => {
      if (rowNo < AutoOrderExcelParser.DATA_START_ROW) return;

      const phone = this.cell(row, 'B');
      const email = this.cell(row, 'D');
      if (!phone && !email) return; // 완전 빈 행은 스킵(입력 자체가 없음)

      rows.push({
        rowNo,
        phone: this.emptyToNull(phone),
        email: this.emptyToNull(email),
        productCode: this.emptyToNull(this.cell(row, 'H')),
        amount: this.toInt(this.cell(row, 'J')),
        isValid: this.cell(row, 'M').toUpperCase() === 'TRUE',
        statusReason: this.emptyToNull(this.cell(row, 'N')),
        replaceCharacter1: this.emptyToNull(this.cell(row, 'P')),
        replaceCharacter2: this.emptyToNull(this.cell(row, 'Q')),
        replaceCharacter3: this.emptyToNull(this.cell(row, 'R')),
      });
    });

    return rows;
  }

  /**
   * 셀 값을 문자열로 안전 추출.
   * ★ J열(수량), M열(_유효) 등은 수식 셀 → .value가 { formula, result } 객체이므로 result를 꺼낸다.
   */
  private cell(target: ExcelJS.Worksheet | ExcelJS.Row, address: string): string {
    const value = target.getCell(address).value;
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') {
      // ExcelJS 셀 값 유니온(수식/리치텍스트/하이퍼링크)을 폭넓게 흡수
      const v = value as { result?: unknown; richText?: { text: string }[]; text?: unknown };
      if ('result' in v) return String(v.result ?? '').trim(); // 수식 셀 → 계산 결과
      if ('richText' in v && v.richText) return v.richText.map((t) => t.text).join('').trim();
      if ('text' in v) return String(v.text ?? '').trim(); // 하이퍼링크 표시문구 등
      return '';
    }
    return String(value).trim();
  }

  private emptyToNull(s: string): string | null {
    return s === '' ? null : s;
  }

  private toInt(s: string): number {
    const n = parseInt(s, 10);
    return Number.isNaN(n) ? 0 : n;
  }

  private toBool(s: string): boolean {
    return s.toUpperCase() === 'TRUE';
  }

  /** 엑셀 한글 발신수단 → enum. 알 수 없으면 null(2단계에서 오류 처리) */
  private toSendMethod(s: string): IOrderSendMethod | null {
    switch (s.replace(/\s/g, '')) {
      case '알림톡':
        return IOrderSendMethod.ALIM_TALK;
      case '문자':
        return IOrderSendMethod.MMS;
      case '이메일':
        return IOrderSendMethod.EMAIL;
      default:
        return null;
    }
  }

  /** 발송희망일(YYYY-MM-DD) + 시간(HH:MM)을 KST 기준 Date로. 파싱 불가 시 null */
  private toKstDate(dateStr: string, timeStr: string): Date | null {
    if (!dateStr) return null;
    // 파서가 date 셀을 ISO로 넘겼을 수 있어 앞 10자리(YYYY-MM-DD)만 취한다
    const ymd = dateStr.slice(0, 10);
    const hm = /^\d{1,2}:\d{2}$/.test(timeStr) ? timeStr.padStart(5, '0') : '00:00';
    const d = new Date(`${ymd}T${hm}:00+09:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
}
