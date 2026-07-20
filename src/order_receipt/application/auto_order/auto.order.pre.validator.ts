import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ForbiddenWordMatcher } from '../../../forbidden_word/application/forbidden.word.matcher';
import { IOrderType } from '../../../order/interface/order.type';
import { IOrderSendMethod } from '../../../order/interface/order.send.method';
import { validateSsgReservationWindow } from '../../../order/domain/order.validation';
import {
  BlockReason,
  MappedRow,
  ParsedHeader,
  PreValidateInput,
  PreValidateResult,
  resolveDeliveryTarget,
} from './auto.order.types';

/**
 * 4단계 - 사전검증 (이 설계의 심장).
 * createTemp가 throw할 조건 중 아래 열거된 것들을 미리 검사해 예외 대신 blocked 리포트로 변환한다.
 * (전부가 아니라 수기로 동기화한 부분집합 — createTemp에 새 검증이 추가되면 여기에도 반영해야
 *  preview=commit이 유지된다.)
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
  private readonly logger = new Logger(AutoOrderPreValidator.name);

  constructor(private readonly forbiddenWordMatcher: ForbiddenWordMatcher) {}

  validate(input: PreValidateInput): PreValidateResult {
    const { header, generalRows, ssgRows } = input;
    const blocked: BlockReason[] = [];

    // ── FILE ⓪ 접수 소유자 없음 → 전체 차단(소유자 없이 전체허용 폴백 금지; commit 시 createTemp가 어차피 throw)
    if (input.ownerMissing) {
      blocked.push({
        code: 'RECEIPT_OWNER_MISSING',
        level: 'FILE',
        reason: '접수 소유자(기업 사용자) 정보를 찾을 수 없어 자동주문을 생성할 수 없습니다.',
      });
    }

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

    // ── FILE ②-b EMAIL인데 주입할 발신주소(등록/기본계정)가 없음 → 발송확정 단계 throw를 사전 차단(preview=commit)
    if (header.sendMethod === IOrderSendMethod.EMAIL && !input.resolvedFromEmail) {
      blocked.push({
        code: 'EMAIL_SENDER_MISSING',
        level: 'FILE',
        reason: '이메일 발신주소가 등록돼 있지 않아 이메일 자동주문을 생성할 수 없습니다.',
      });
    }

    // ── ROW ③ 대치문자 금칙어 + 수신처 없음 (수신자별 값 → 그 행만 제외)
    const blockedRowNos = new Set<number>();
    for (const row of [...generalRows, ...ssgRows]) {
      this.scanReplaceCharacters(row, blocked, blockedRowNos);
      this.checkDeliveryTarget(header, row, blocked, blockedRowNos);
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
        // validateSsgReservationWindow는 예약창/혼합/시각누락 위반을 BadRequestException으로 던진다.
        // 그 외 예외(잘못된 range 객체·널참조·향후 추가된 검증 등)를 "기간 밖" 비즈니스 사유로 둔갑시키면
        // SSG 주문이 조용히 스킵되고 Sentry에도 안 남는다 → BadRequest만 사유화하고 나머지는 표면화한다.
        if (!(e instanceof BadRequestException)) {
          this.logger.error(`SSG 예약창 검증 중 예기치 못한 오류(기간 밖 아님): ${(e as Error)?.message}`);
          throw e;
        }
        ssgOrderBlocked = true;
        blocked.push({
          code: 'SSG_RESERVATION_WINDOW',
          level: 'ORDER',
          reason: e.message,
        });
      }
    }

    const fileBlocked = blocked.some((b) => b.level === 'FILE');
    return { blocked, blockedRowNos, ssgOrderBlocked, fileBlocked };
  }

  /**
   * 발신수단에 맞는 수신처(EMAIL=이메일, 그 외=휴대폰)가 없으면 그 행을 ROW 차단.
   * → payload 조립 단계에서 조용히 빠지던 행이 "사유 있는 제외"로 검산에 집계된다.
   */
  private checkDeliveryTarget(
    header: ParsedHeader,
    row: MappedRow,
    blocked: BlockReason[],
    blockedRowNos: Set<number>,
  ): void {
    const target = resolveDeliveryTarget(header.sendMethod, row);
    if (target) return;
    blockedRowNos.add(row.rowNo);
    blocked.push({
      code: 'MISSING_DELIVERY_TARGET',
      level: 'ROW',
      rowNo: row.rowNo,
      reason:
        header.sendMethod === IOrderSendMethod.EMAIL
          ? `${row.rowNo}행: 이메일 발송인데 이메일 주소(D)가 없습니다.`
          : `${row.rowNo}행: 수신 휴대폰 번호(B)가 없습니다.`,
    });
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
