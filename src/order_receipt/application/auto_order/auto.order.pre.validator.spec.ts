import { AutoOrderPreValidator } from './auto.order.pre.validator';
import * as OrderValidation from '../../../order/domain/order.validation';
import { ForbiddenWordMatcher } from '../../../forbidden_word/application/forbidden.word.matcher';
import { ProductEntity } from '../../../entity/product.entity';
import { IProductType } from '../../../product/interface/product.type';
import { IOrderSendMethod } from '../../../order/interface/order.send.method';
import { MappedRow, ParsedHeader, PreValidateInput } from './auto.order.types';

/** '도박'을 금칙어로 판정하는 가짜 매처 */
const fakeMatcher = {
  scan: (t?: string | null) => (t && t.includes('도박') ? ['도박'] : []),
} as unknown as ForbiddenWordMatcher;

function header(overrides: Partial<ParsedHeader> = {}): ParsedHeader {
  return {
    formVersion: 'v4.1-immediate-send',
    eventName: '이벤트',
    sendTitle: '정상 제목',
    sendContent: '정상 내용',
    sendMethod: IOrderSendMethod.MMS,
    fromPhoneNumber: '1644-3614',
    isImmediate: true,
    sendDate: '',
    sendTime: '',
    sendRequestAt: null,
    destroyDay: 90,
    ...overrides,
  };
}

function mappedRow(rowNo: number, overrides: Partial<MappedRow> = {}): MappedRow {
  return {
    rowNo,
    phone: '010-0000-0000',
    email: null,
    productCode: 'P-1',
    amount: 1,
    isValid: true,
    statusReason: 'ok',
    replaceCharacter1: null,
    replaceCharacter2: null,
    replaceCharacter3: null,
    product: { code: 'P-1', type: IProductType.GENERAL, price: 5000 } as ProductEntity,
    ...overrides,
  };
}

function input(overrides: Partial<PreValidateInput> = {}): PreValidateInput {
  return {
    header: header(),
    generalRows: [mappedRow(5)],
    ssgRows: [],
    userAllowedSendMethods: null,
    ownerMissing: false,
    ssgReservationRange: null,
    resolvedFromEmail: 'sender@enmad.com',
    ...overrides,
  };
}

describe('AutoOrderPreValidator', () => {
  const validator = new AutoOrderPreValidator(fakeMatcher);

  it('정상 입력은 차단 없음', () => {
    const r = validator.validate(input());
    expect(r.blocked).toHaveLength(0);
    expect(r.fileBlocked).toBe(false);
    expect(r.blockedRowNos.size).toBe(0);
    expect(r.ssgOrderBlocked).toBe(false);
  });

  it('소유자 없음 → FILE 차단', () => {
    const r = validator.validate(input({ ownerMissing: true }));
    expect(r.fileBlocked).toBe(true);
    expect(r.blocked.some((b) => b.code === 'RECEIPT_OWNER_MISSING' && b.level === 'FILE')).toBe(true);
  });

  it('휴대폰 없는 행(문자 발송) → ROW 차단(MISSING_DELIVERY_TARGET)', () => {
    const rows = [mappedRow(5, { phone: null }), mappedRow(6, { phone: '010-2345-6789' })];
    const r = validator.validate(input({ generalRows: rows }));
    expect([...r.blockedRowNos]).toEqual([5]);
    expect(r.blocked.some((b) => b.code === 'MISSING_DELIVERY_TARGET' && b.rowNo === 5)).toBe(true);
  });

  it('EMAIL 발송인데 이메일 없는 행 → ROW 차단', () => {
    const rows = [mappedRow(5, { email: null, phone: '010-1' })];
    const r = validator.validate(input({ header: header({ sendMethod: IOrderSendMethod.EMAIL }), generalRows: rows }));
    expect([...r.blockedRowNos]).toEqual([5]); // 휴대폰 있어도 이메일 없으면 이메일발송은 차단
  });

  it('EMAIL인데 이메일 형식 아님(이름) → ROW 차단(INVALID_DELIVERY_TARGET)', () => {
    const rows = [mappedRow(5, { email: '홍길동', phone: null })];
    const r = validator.validate(input({ header: header({ sendMethod: IOrderSendMethod.EMAIL }), generalRows: rows }));
    expect([...r.blockedRowNos]).toEqual([5]);
    expect(r.blocked.some((b) => b.code === 'INVALID_DELIVERY_TARGET' && b.rowNo === 5)).toBe(true);
  });

  it('휴대폰 형식 아님(문자열) → ROW 차단(INVALID_DELIVERY_TARGET)', () => {
    const rows = [mappedRow(5, { phone: '없는번호' }), mappedRow(6, { phone: '010-2345-6789' })];
    const r = validator.validate(input({ generalRows: rows }));
    expect([...r.blockedRowNos]).toEqual([5]); // 6행은 정상 형식이라 통과
    expect(r.blocked.some((b) => b.code === 'INVALID_DELIVERY_TARGET' && b.rowNo === 5)).toBe(true);
  });

  it('정상 이메일 형식은 차단 없음', () => {
    const rows = [mappedRow(5, { email: 'a@x.com', phone: null })];
    const r = validator.validate(input({ header: header({ sendMethod: IOrderSendMethod.EMAIL }), generalRows: rows }));
    expect(r.blocked.some((b) => b.code === 'INVALID_DELIVERY_TARGET')).toBe(false);
  });

  it('제목 금칙어 → FILE 차단(TITLE, 마스킹)', () => {
    const r = validator.validate(input({ header: header({ sendTitle: '도박 사이트' }) }));
    expect(r.fileBlocked).toBe(true);
    const b = r.blocked.find((x) => x.field === 'TITLE');
    expect(b?.level).toBe('FILE');
    expect(b?.matched).toBe('도*'); // 원문 노출 방지
  });

  it('내용 금칙어 → FILE 차단(CONTENT)', () => {
    const r = validator.validate(input({ header: header({ sendContent: '도박 광고' }) }));
    expect(r.blocked.some((b) => b.field === 'CONTENT' && b.level === 'FILE')).toBe(true);
  });

  // createTemp.assertNoForbiddenWord가 eventName도 검사하므로 사전검증에도 있어야 preview=commit이 성립
  it('프로모션명 금칙어 → FILE 차단(EVENT_NAME, 마스킹)', () => {
    const r = validator.validate(input({ header: header({ eventName: '도박 프로모션' }) }));
    expect(r.fileBlocked).toBe(true);
    const b = r.blocked.find((x) => x.field === 'EVENT_NAME');
    expect(b?.code).toBe('FORBIDDEN_WORD');
    expect(b?.level).toBe('FILE');
    expect(b?.matched).toBe('도*'); // 원문 노출 방지
  });

  it('발신수단 미허용 → FILE 차단', () => {
    const r = validator.validate(
      input({ header: header({ sendMethod: IOrderSendMethod.EMAIL }), userAllowedSendMethods: 'ALIM_TALK,MMS' }),
    );
    expect(r.blocked.some((b) => b.code === 'SEND_METHOD_NOT_ALLOWED')).toBe(true);
    expect(r.fileBlocked).toBe(true);
  });

  it('EMAIL인데 발신주소 확보 실패(resolvedFromEmail=null) → FILE 차단', () => {
    const r = validator.validate(
      input({ header: header({ sendMethod: IOrderSendMethod.EMAIL }), resolvedFromEmail: null }),
    );
    expect(r.fileBlocked).toBe(true);
    expect(r.blocked.some((b) => b.code === 'EMAIL_SENDER_MISSING' && b.level === 'FILE')).toBe(true);
  });

  it('EMAIL인데 발신주소 확보됨 → EMAIL_SENDER_MISSING 없음', () => {
    const r = validator.validate(
      input({ header: header({ sendMethod: IOrderSendMethod.EMAIL }), resolvedFromEmail: 'sender@enmad.com' }),
    );
    expect(r.blocked.some((b) => b.code === 'EMAIL_SENDER_MISSING')).toBe(false);
  });

  it('SMS→MMS 정규화: allowedSendMethods=SMS면 MMS 발송 허용', () => {
    const r = validator.validate(
      input({ header: header({ sendMethod: IOrderSendMethod.MMS }), userAllowedSendMethods: 'ALIM_TALK,SMS' }),
    );
    expect(r.blocked.some((b) => b.code === 'SEND_METHOD_NOT_ALLOWED')).toBe(false);
  });

  it('대치문자 금칙어 → ROW 차단(해당 행만, 카운트 1회)', () => {
    const rows = [
      mappedRow(5, { replaceCharacter1: '도박' }),
      mappedRow(6, { replaceCharacter1: '정상' }),
    ];
    const r = validator.validate(input({ generalRows: rows }));
    expect(r.fileBlocked).toBe(false); // 파일 전체는 살아있음
    expect([...r.blockedRowNos]).toEqual([5]);
    expect(r.blocked.every((b) => b.level === 'ROW')).toBe(true);
  });

  it('한 행 대치문자 여러 개 걸려도 카운트는 1회(사유는 여러 건)', () => {
    const rows = [mappedRow(5, { replaceCharacter1: '도박', replaceCharacter2: '도박판' })];
    const r = validator.validate(input({ generalRows: rows }));
    expect(r.blockedRowNos.size).toBe(1); // 행 1개
    expect(r.blocked.length).toBeGreaterThanOrEqual(2); // 사유는 2건 이상
  });

  it('SSG 예약창 밖 → ORDER 차단(ssgOrderBlocked)', () => {
    const r = validator.validate(
      input({
        header: header({ isImmediate: false, sendRequestAt: new Date('2026-08-10T00:00:00+09:00') }),
        ssgRows: [mappedRow(5, { product: { code: 'S-1', type: IProductType.SSG, price: 10000 } as ProductEntity })],
        ssgReservationRange: { startDate: new Date('2026-07-01'), endDate: new Date('2026-07-31') },
      }),
    );
    expect(r.ssgOrderBlocked).toBe(true);
    expect(r.blocked.some((b) => b.code === 'SSG_RESERVATION_WINDOW' && b.level === 'ORDER')).toBe(true);
  });

  it('SSG 예약창 안 → 차단 없음', () => {
    const r = validator.validate(
      input({
        header: header({ isImmediate: false, sendRequestAt: new Date('2026-07-15T00:00:00+09:00') }),
        ssgRows: [mappedRow(5, { product: { code: 'S-1', type: IProductType.SSG, price: 10000 } as ProductEntity })],
        ssgReservationRange: { startDate: new Date('2026-07-01'), endDate: new Date('2026-07-31') },
      }),
    );
    expect(r.ssgOrderBlocked).toBe(false);
  });

  // ── 리뷰 반영(Finding D): SSG 검증이 BadRequest가 아닌 예외를 던지면 "기간 밖"으로 둔갑시키지 않고 표면화(rethrow)
  it('SSG 검증이 예기치 못한(비-BadRequest) 오류를 던지면 삼키지 않고 rethrow', () => {
    const spy = jest
      .spyOn(OrderValidation, 'validateSsgReservationWindow')
      .mockImplementation(() => {
        throw new TypeError('예상치 못한 내부 오류');
      });
    try {
      expect(() =>
        validator.validate(
          input({
            header: header({ isImmediate: false, sendRequestAt: new Date('2026-07-15T00:00:00+09:00') }),
            ssgRows: [mappedRow(5, { product: { code: 'S-1', type: IProductType.SSG, price: 10000 } as ProductEntity })],
          }),
        ),
      ).toThrow('예상치 못한 내부 오류');
    } finally {
      spy.mockRestore();
    }
  });
});
