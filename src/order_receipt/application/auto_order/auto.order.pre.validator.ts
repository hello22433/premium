import { Injectable } from '@nestjs/common';
import { ForbiddenWordMatcher } from '../../../forbidden_word/application/forbidden.word.matcher';
import { IOrderType } from '../../../order/interface/order.type';
import { validateSsgReservationWindow } from '../../../order/domain/order.validation';
import { BlockReason, MappedRow, PreValidateInput, PreValidateResult } from './auto.order.types';

/**
 * 4단계 - 사전검증 (이 설계의 심장).
 * createTemp가 throw할 조건을 미리 검사해 예외 대신 blocked 리포트로 변환한다.
 * → 미리보기(DRY_RUN)와 승인(COMMIT)이 "똑같이" 막힘을 보고하므로 preview=commit이 성립한다.
 *
 * 차단 레벨:
 *  - FILE : 제목/내용 금칙어, 발신수단 미허용 → 공유값이라 파일 전체 차단
 *  - ROW  : 대치문자 금칙어 → 수신자별 값이라 그 행만 제외(나머지 생성)
 *  - ORDER: SSG 예약창 밖 → SSG 주문만 스킵(일반 주문은 생성)
 *
 * createTemp 로직과의 동기화:
 *  - 발신수단: validateSendMethods와 동일(allowedSendMethods 폴백 + SMS→MMS 정규화)
 *  - 금칙어:   동일 ForbiddenWordMatcher.scan 사용
 *  - SSG창:    validateSsgReservationWindow를 try/catch로 재사용(완전 동기화)
 */
@Injectable()
export class AutoOrderPreValidator {
  private static readonly DEFAULT_SEND_METHODS = ['ALIM_TALK', 'MMS', 'EMAIL'];

  constructor(private readonly forbiddenWordMatcher: ForbiddenWordMatcher) {}

  validate(input: PreValidateInput): PreValidateResult {
    const { header, generalRows, ssgRows } = input;
    const blocked: BlockReason[] = [];

    // ── FILE ① 제목/내용 금칙어 (모든 수신자 공유값 → 오염 시 파일 전체 차단)
    const titleHits = this.forbiddenWordMatcher.scan(header.sendTitle);
    if (titleHits.length > 0) {
      blocked.push({
        code: 'FORBIDDEN_WORD',
        level: 'FILE',
        field: 'TITLE',
        matched: this.mask(titleHits[0]),
        reason: '발송 제목(C20)에 금칙어가 포함되어 있습니다.',
      });
    }
    const contentHits = this.forbiddenWordMatcher.scan(header.sendContent);
    if (contentHits.length > 0) {
      blocked.push({
        code: 'FORBIDDEN_WORD',
        level: 'FILE',
        field: 'CONTENT',
        matched: this.mask(contentHits[0]),
        reason: '발송 내용(C21)에 금칙어가 포함되어 있습니다.',
      });
    }

    // ── FILE ② 발신수단 미허용 (createTemp.validateSendMethods와 동일 규칙)
    const allowed = input.userAllowedSendMethods
      ? input.userAllowedSendMethods.split(',').map((m) => (m === 'SMS' ? 'MMS' : m))
      : AutoOrderPreValidator.DEFAULT_SEND_METHODS;
    if (header.sendMethod && !allowed.includes(header.sendMethod)) {
      blocked.push({
        code: 'SEND_METHOD_NOT_ALLOWED',
        level: 'FILE',
        reason: `발신수단 '${header.sendMethod}'(C23)은 이 계정에 허용되지 않았습니다.`,
      });
    }

    // ── ROW ③ 대치문자 금칙어 (수신자별 값 → 그 행만 제외)
    const blockedRowNos = new Set<number>();
    for (const row of [...generalRows, ...ssgRows]) {
      this.scanReplaceCharacters(row, blocked, blockedRowNos);
    }

    // ── ORDER ④ SSG 예약창 (createTemp의 validateSsgReservationWindow 재사용 → 완전 동기화)
    let ssgOrderBlocked = false;
    if (ssgRows.length > 0) {
      try {
        validateSsgReservationWindow(
          IOrderType.SSG,
          [{ sendType: header.isImmediate ? 'IMMEDIATE' : 'RESERVE', sendRequestAt: header.sendRequestAt }],
          input.ssgReservationRange,
        );
      } catch (e) {
        ssgOrderBlocked = true;
        blocked.push({
          code: 'SSG_RESERVATION_WINDOW',
          level: 'ORDER',
          reason: e instanceof Error ? e.message : 'SSG 예약 가능 기간 밖입니다.',
        });
      }
    }

    const fileBlocked = blocked.some((b) => b.level === 'FILE');
    return { blocked, blockedRowNos, ssgOrderBlocked, fileBlocked };
  }

  /** 한 행의 대치문자 1/2/3을 검사. 하나라도 걸리면 그 행을 ROW 차단(사유는 걸린 만큼 보고, 카운트는 Set으로 1회). */
  private scanReplaceCharacters(row: MappedRow, blocked: BlockReason[], blockedRowNos: Set<number>): void {
    const chars = [row.replaceCharacter1, row.replaceCharacter2, row.replaceCharacter3];
    for (const ch of chars) {
      if (!ch) continue;
      const hits = this.forbiddenWordMatcher.scan(ch);
      if (hits.length === 0) continue;
      blockedRowNos.add(row.rowNo);
      blocked.push({
        code: 'FORBIDDEN_WORD',
        level: 'ROW',
        rowNo: row.rowNo,
        field: 'REPLACE_CHAR',
        matched: this.mask(hits[0]),
        reason: `${row.rowNo}행 대치문자에 금칙어가 포함되어 있습니다.`,
      });
    }
  }

  /** 금칙어 원문 노출 방지: '도박' → '도*' */
  private mask(word: string): string {
    if (word.length <= 1) return '*';
    return word[0] + '*'.repeat(word.length - 1);
  }
}
