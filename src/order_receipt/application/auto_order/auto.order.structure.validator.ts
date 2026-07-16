import { Injectable } from '@nestjs/common';
import { ParsedFile, StructureResult } from './auto.order.types';

/**
 * 2단계 - 구조검증.
 * "이 파일이 우리 v4.1 양식이 맞는가"만 판정한다.
 * 실패 시 파일 전체를 INVALID_FORMAT으로 리젝(셀 위치가 다르면 엉뚱한 값으로 주문이 생기므로 조기 차단).
 */
@Injectable()
export class AutoOrderStructureValidator {
  private static readonly SUPPORTED_VERSION = 'v4.1-immediate-send';

  validate(parsed: ParsedFile): StructureResult {
    if (parsed.parseError === 'SHEET_MISSING' || !parsed.header) {
      return this.invalid('필수 시트(1.신청정보 / 2.발송명단)가 없습니다.');
    }

    const h = parsed.header;

    if (h.formVersion !== AutoOrderStructureValidator.SUPPORTED_VERSION) {
      return this.invalid(
        `지원하지 않는 양식버전입니다. (파일: ${h.formVersion || '없음'} / 지원: ${AutoOrderStructureValidator.SUPPORTED_VERSION})`,
      );
    }
    if (!h.eventName) return this.invalid('프로모션명(C19)이 비어 있습니다.');
    if (!h.sendTitle) return this.invalid('발송 제목(C20)이 비어 있습니다.');
    if (!h.sendContent) return this.invalid('발송 내용(C21)이 비어 있습니다.');
    if (!h.sendMethod) return this.invalid('발신수단(C23)이 비어 있거나 알 수 없는 값입니다.');
    if (h.destroyDay < 1) {
      return this.invalid('개인정보 파기일(C25)이 비어 있거나 올바르지 않습니다.');
    }
    if (!h.isImmediate && !h.sendRequestAt) {
      return this.invalid('예약발송인데 발송희망일/시간(C17/C18)이 올바르지 않습니다.');
    }
    if (parsed.rows.length === 0) return this.invalid('발송명단에 데이터가 없습니다.');

    return { status: 'VALID', message: null };
  }

  private invalid(message: string): StructureResult {
    return { status: 'INVALID_FORMAT', message };
  }
}
