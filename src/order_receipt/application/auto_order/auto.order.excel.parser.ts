import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { IOrderSendMethod } from '../../../order/interface/order.send.method';
import { ParsedFile, ParsedHeader, ParsedRow } from './auto.order.types';

/**
 * 1단계 - 엑셀 파서.
 * 구조/양식 검증은 하지 않고 셀 값만 꺼낸다(검증은 2단계 구조검증에서).
 * 다만 완전 빈 행 스킵/_유효 판독 등 행 단위 추출 판단은 여기서 한다.
 *
 * 셀 주소는 v4.1 양식('v4.1-immediate-send') 실물 기준 하드코딩:
 *   - 1.신청정보 헤더: C열 (C1 양식버전, C16~C25)
 *   - 2.발송명단 행:   B(휴대폰) D(이메일) H(상품코드) J(수량) M(_유효) N(_상태) P/Q/R(대치문자)
 * 양식 개정 시 이 주소들이 조용히 rot되므로, SUPPORTED_VERSION 불일치를 2단계에서 먼저 리젝한다.
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

    // eachRow 콜백의 rowNumber는 엑셀과 동일한 1-based → 그대로 rowNo로 사용
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
        isValid: this.toBool(this.cell(row, 'M')),
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

  /**
   * 발송희망일(C17) + 시간(C18)을 KST 기준 Date로. 파싱 불가 시 null → 구조검증에서 리젝.
   * ★ 시간이 불량(빈값/범위초과/알수없음)이면 조용히 00:00으로 떨어뜨리지 않고 null 반환한다.
   *   (예약발송이 의도한 시각이 아닌 자정에 조용히 나가는 사고 방지)
   * 셀이 텍스트('14:30')든 네이티브 시간셀(cell()이 ISO로 변환)이든 모두 흡수한다.
   */
  private toKstDate(dateStr: string, timeStr: string): Date | null {
    // 날짜: 텍스트('2026-08-05')든 ISO든 앞 10자리만
    const ymd = dateStr.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;

    // ★ 존재하지 않는 달력 날짜(예: 2026-02-30, 2026-04-31)는 정규식은 통과하지만 실재하지 않는다.
    //   new Date(...)는 이런 날짜를 Invalid로 만들지 않고 조용히 롤오버(2/30→3/2, 4/31→5/1)시켜
    //   "다른 날짜의 정상 예약발송"으로 둔갑시킨다. 연·월·일을 분해해 롤오버 없이 그대로 일치하는지
    //   UTC 기준(타임존 무관)으로 확인해 실재하지 않는 날짜를 리젝한다.
    const [y, mo, day] = ymd.split('-').map(Number);
    const probe = new Date(Date.UTC(y, mo - 1, day));
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== day) {
      return null;
    }

    const hm = this.extractHhmm(timeStr);
    if (hm === null) return null; // 시간 불량 → 리젝(자정 폴백 금지)

    const d = new Date(`${ymd}T${hm}:00+09:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  /** 'HH:MM'/'H:MM' 또는 네이티브 시간셀 ISO('...T14:30:...')에서 시각 추출 + 범위검증. 불량 시 null */
  private extractHhmm(timeStr: string): string | null {
    if (!timeStr) return null;
    // 텍스트 'HH:MM' 우선, 실패 시 ISO 시간부 추출
    const m = timeStr.match(/^(\d{1,2}):(\d{2})$/) ?? timeStr.match(/T(\d{2}):(\d{2})/);
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null; // '25:99' 등 거부
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  }
}
