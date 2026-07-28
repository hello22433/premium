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
 *   - 2.발송명단 행:   B(휴대폰) D(이메일) F(브랜드) G(상품명) H(상품코드) I(정상가) J(수량) M(_유효) N(_상태) P/Q/R(대치문자)
 * 양식 개정 시 이 주소들이 조용히 rot되므로, SUPPORTED_VERSION 불일치를 2단계에서 먼저 리젝한다.
 */
@Injectable()
export class AutoOrderExcelParser {
  private static readonly INFO_SHEET = '1.신청정보';
  private static readonly LIST_SHEET = '2.발송명단';
  private static readonly DATA_START_ROW = 5; // 1~4행은 META/헤더/안내
  static readonly MAX_LIST_ROWS = 10_000; // 발송명단 행수 상한(신뢰경계 밖 입력 DoS/메모리 방어). 초과 시 리젝
  /** 수식 결과 캐시 방어 대상 열: M(_유효, 제외 키) H(상품코드) I(정상가) — 셋 다 미캐시면 전건이 조용히 사라진다 */
  private static readonly FORMULA_GUARD_COLUMNS = ['M', 'H', 'I'] as const;

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
    const { rows, overflow } = this.parseRows(list);

    // 행수 상한 초과 = 신뢰경계 밖 대용량 입력 → 파일 단위 리젝(파싱 메모리도 상한에서 바운드됨).
    if (overflow) {
      return { header, rows, parseError: 'TOO_MANY_ROWS' };
    }
    // ★ M(_유효)/H(상품코드)/I(정상가) 수식의 계산 결과가 캐시되지 않은 파일(엑셀이 결과 없이 저장 — 프로그램
    //   생성/일부 오피스, 또는 수식만 고쳐 재계산 없이 저장)은 result가 undefined라 cell()이 ''로 읽혀
    //   전건 제외(M) 또는 전건 미매핑(H/I)이 되는데도 검산은 초록이 된다. 신뢰 불가 파일이므로 파일 단위로 리젝한다.
    const formulaUncached = this.hasUncachedFormulaResults(list, rows);
    return { header, rows, parseError: formulaUncached ? 'FORMULA_NOT_CACHED' : null };
  }

  private parseHeader(info: ExcelJS.Worksheet): ParsedHeader {
    const sendDate = this.cell(info, 'C17');
    const sendTime = this.cell(info, 'C18');
    const isImmediate = this.parseImmediate(this.cell(info, 'C16'));

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
      // 즉시발송(true)이면 예약시각 없음. null(해석불가)은 구조검증에서 리젝되므로 여기선 도출만 시도.
      sendRequestAt: isImmediate === true ? null : this.toKstDate(sendDate, sendTime),
      destroyDay: this.toInt(this.cell(info, 'C25')),
    };
  }

  private parseRows(list: ExcelJS.Worksheet): { rows: ParsedRow[]; overflow: boolean } {
    const rows: ParsedRow[] = [];
    let overflow = false;

    // eachRow 콜백의 rowNumber는 엑셀과 동일한 1-based → 그대로 rowNo로 사용
    list.eachRow({ includeEmpty: false }, (row, rowNo) => {
      if (rowNo < AutoOrderExcelParser.DATA_START_ROW) return;

      const phone = this.cell(row, 'B');
      const email = this.cell(row, 'D');
      const productName = this.cell(row, 'G');
      const productCode = this.cell(row, 'H');
      // 스킵은 '주문 의도가 전혀 없는 행'만 — 상품명(G)/상품코드(H)가 있으면 연락처(B/D)가 비어도 유지한다.
      // 연락처만 빠진 행을 여기서 버리면 inputRowCount에도 안 잡혀 하류 checkDeliveryTarget이
      // MISSING_DELIVERY_TARGET으로 표면화하지 못하고 검산도 통과해버린다(사유 없는 silent drop). → 유지해 집계되게.
      // (G는 사용자가 직접 입력하는 유일한 상품 식별자다. H는 2A 매칭 실패 시 ''이 되므로 G까지 봐야 의도를 놓치지 않는다.)
      if (!phone && !email && !productCode && !productName) return;

      // 상한 초과 → 더 이상 push하지 않아 메모리를 상한에서 바운드(eachRow는 중단 불가, 누적만 차단)
      if (rows.length >= AutoOrderExcelParser.MAX_LIST_ROWS) {
        overflow = true;
        return;
      }

      rows.push({
        rowNo,
        phone: this.emptyToNull(phone),
        email: this.emptyToNull(email),
        brand: this.emptyToNull(this.cell(row, 'F')),
        productName: this.emptyToNull(productName),
        productCode: this.emptyToNull(productCode),
        listPrice: this.toInt(this.cell(row, 'I')),
        amount: this.toInt(this.cell(row, 'J')),
        isValid: this.toBool(this.cell(row, 'M')),
        statusReason: this.emptyToNull(this.cell(row, 'N')),
        replaceCharacter1: this.emptyToNull(this.cell(row, 'P')),
        replaceCharacter2: this.emptyToNull(this.cell(row, 'Q')),
        replaceCharacter3: this.emptyToNull(this.cell(row, 'R')),
      });
    });

    return { rows, overflow };
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

  /**
   * M(_유효) 등 boolean 셀 해석. 명시적 참 토큰만 true.
   * ★ parseImmediate와 동일한 토큰 집합을 쓴다: 엑셀 boolean 캐시는 <v>1</v>이라, ExcelJS가 boolean으로
   *   변환하지 않는 경로(수식 결과 캐시를 숫자로 돌려주는 경우 등)에서 '1'이 오면 과거 구현은 false로 읽어
   *   전 행을 사유 없이 제외시켰다(제외는 정상 흐름이라 경고도 안 뜬다).
   */
  private toBool(s: string): boolean {
    return this.parseBoolean(s) === true;
  }

  /**
   * C16(즉시발송 여부)를 3-상태로 해석: true/false/null.
   * ★ 과거엔 정확히 'TRUE'만 즉시로 보고 그 외 전부를 예약으로 떨궈, 빈값/오타/체크박스/로컬표기 같은
   *   모호한 값이 조용히 "예약발송"으로 둔갑했다(엉뚱한 시각 발송 위험). 명시적 참/거짓 토큰만 인정하고
   *   알 수 없으면 null → 구조검증에서 리젝한다.
   */
  private parseImmediate(s: string): boolean | null {
    return this.parseBoolean(s);
  }

  /** 엑셀이 boolean을 표현하는 모든 표기(TRUE/1/Y/예…)를 3-상태로 해석. 알 수 없으면 null. */
  private parseBoolean(s: string): boolean | null {
    const v = s.trim().toUpperCase();
    if (['TRUE', '1', 'Y', 'O', '예', '즉시', '즉시발송'].includes(v)) return true;
    if (['FALSE', '0', 'N', 'X', '아니오', '예약', '예약발송'].includes(v)) return false;
    return null;
  }

  private isFormulaCell(target: ExcelJS.Worksheet | ExcelJS.Row, address: string): boolean {
    const value = target.getCell(address).value as { formula?: unknown; sharedFormula?: unknown } | null;
    return !!value && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value);
  }

  /** 대상 셀이 수식이고 계산 결과가 캐시돼 있는지(result 존재). */
  private hasCachedFormulaResult(target: ExcelJS.Worksheet | ExcelJS.Row, address: string): boolean {
    const value = target.getCell(address).value as { result?: unknown } | null;
    return this.isFormulaCell(target, address) && value!.result !== undefined && value!.result !== null;
  }

  /**
   * "수식 결과가 계산 없이 저장돼 미캐시"인 파일인지 판정(M/H/I 열).
   * ★ M(_유효)은 제외의 유일한 키라 미캐시면 전건 false로 읽혀 전원 조용히 사라진다.
   *   H(상품코드)·I(정상가)는 상품 확보의 유일한 키라 미캐시면 전건 미매핑 → 주문 0건이 된다.
   *   (M만 검사하던 구현은 H/I 미캐시 파일을 VALID로 통과시켜 "주문 0건"을 사유 없이 만들었다)
   * ★ 판정은 열 단위: "그 열에 수식이 있는데 캐시된 결과가 한 셀도 없을 때"만 미캐시로 본다.
   *   (실측 파일은 FALSE 결과도 <v>0</v>으로 캐시돼 있었다 — 즉 falsy 캐시가 생략된다는 전제는 성립하지 않는다.
   *    전 행이 falsy/빈값인 열은 오탐될 수 있으나, 그런 파일은 어차피 주문 0건이라 피해는 "재저장 안내" 뿐 —
   *    진짜 유실을 놓치는 것보다 안전한 오탐이다.)
   */
  private hasUncachedFormulaResults(list: ExcelJS.Worksheet, rows: ParsedRow[]): boolean {
    if (rows.length === 0) return false;
    return AutoOrderExcelParser.FORMULA_GUARD_COLUMNS.some((col) => {
      const anyFormula = rows.some((r) => this.isFormulaCell(list, `${col}${r.rowNo}`));
      const anyCached = rows.some((r) => this.hasCachedFormulaResult(list, `${col}${r.rowNo}`));
      return anyFormula && !anyCached;
    });
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
