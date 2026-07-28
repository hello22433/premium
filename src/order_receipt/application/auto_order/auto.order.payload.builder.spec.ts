import { AutoOrderPayloadBuilder } from './auto.order.payload.builder';
import { ProductEntity } from '../../../entity/product.entity';
import { IProductType } from '../../../product/interface/product.type';
import { IOrderSendMethod } from '../../../order/interface/order.send.method';
import { IOrderType } from '../../../order/interface/order.type';
import { MappedRow, ParsedHeader } from './auto.order.types';

function header(overrides: Partial<ParsedHeader> = {}): ParsedHeader {
  return {
    formVersion: 'v4.1-immediate-send',
    eventName: '8월 프로모션',
    sendTitle: '제목',
    sendContent: '내용',
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

function product(id: number, type: IProductType = IProductType.GENERAL): ProductEntity {
  return { id, code: `P-${id}`, type, price: 5000 } as ProductEntity;
}

function mappedRow(rowNo: number, prod: ProductEntity, overrides: Partial<MappedRow> = {}): MappedRow {
  return {
    rowNo,
    phone: `010-0000-${String(rowNo).padStart(4, '0')}`,
    email: null,
    brand: null,
    productName: '상품A',
    productCode: prod.code,
    listPrice: 5000,
    amount: 1,
    isValid: true,
    statusReason: 'ok',
    replaceCharacter1: null,
    replaceCharacter2: null,
    replaceCharacter3: null,
    product: prod,
    ...overrides,
  };
}

describe('AutoOrderPayloadBuilder', () => {
  const builder = new AutoOrderPayloadBuilder();
  const p1 = product(1);
  const p2 = product(2);

  it('수량은 행 수 기반, 수신처는 휴대폰(MMS)', () => {
    const rows = [mappedRow(5, p1), mappedRow(6, p1), mappedRow(7, p2)];
    const r = builder.build({ header: header(), rows, orderType: IOrderType.GENERAL, blockedRowNos: new Set() })!;

    expect(r.payload.type).toBe(IOrderType.GENERAL);
    expect(r.payload.eventName).toBe('8월 프로모션');
    expect(r.payload.orderProductList).toHaveLength(2); // 상품 2종

    const op1 = r.payload.orderProductList.find((o) => o.productId === 1)!;
    expect(op1.amount).toBe(2); // 행 수
    expect(op1.orderDeliveryList).toHaveLength(2);
    expect(op1.orderDeliveryList[0].deliveryTarget).toBe('010-0000-0005'); // 휴대폰
    expect(op1.sendMethod).toBe(IOrderSendMethod.MMS);
    expect(r.sourceRowNos).toEqual([5, 6, 7]);
  });

  it('차단 행은 제외', () => {
    const rows = [mappedRow(5, p1), mappedRow(6, p1)];
    const r = builder.build({
      header: header(),
      rows,
      orderType: IOrderType.GENERAL,
      blockedRowNos: new Set([6]),
    })!;
    expect(r.payload.orderProductList[0].amount).toBe(1);
    expect(r.sourceRowNos).toEqual([5]);
  });

  it('EMAIL 발송은 수신처가 이메일(D)', () => {
    const rows = [mappedRow(5, p1, { email: 'a@x.com' })];
    const r = builder.build({
      header: header({ sendMethod: IOrderSendMethod.EMAIL }),
      rows,
      orderType: IOrderType.GENERAL,
      blockedRowNos: new Set(),
    })!;
    expect(r.payload.orderProductList[0].orderDeliveryList[0].deliveryTarget).toBe('a@x.com');
  });

  it('EMAIL 발송: fromEmail 주입 + emailSendType=URL', () => {
    const rows = [mappedRow(5, p1, { email: 'a@x.com' })];
    const r = builder.build({
      header: header({ sendMethod: IOrderSendMethod.EMAIL }),
      rows,
      orderType: IOrderType.GENERAL,
      blockedRowNos: new Set(),
      fromEmail: 'sender@enmad.com',
    })!;
    const op = r.payload.orderProductList[0];
    expect(op.fromEmail).toBe('sender@enmad.com');
    expect(op.emailSendType).toBe('URL');
  });

  it('비-EMAIL(MMS)은 fromEmail/emailSendType null (fromEmail 주입해도 무시)', () => {
    const rows = [mappedRow(5, p1)];
    const r = builder.build({
      header: header({ sendMethod: IOrderSendMethod.MMS }),
      rows,
      orderType: IOrderType.GENERAL,
      blockedRowNos: new Set(),
      fromEmail: 'sender@enmad.com',
    })!;
    const op = r.payload.orderProductList[0];
    expect(op.fromEmail).toBeNull();
    expect(op.emailSendType).toBeNull();
  });

  it('EMAIL 발송인데 이메일 없는 행은 제외(수신처 없음)', () => {
    const rows = [mappedRow(5, p1, { email: 'a@x.com' }), mappedRow(6, p1, { email: null })];
    const r = builder.build({
      header: header({ sendMethod: IOrderSendMethod.EMAIL }),
      rows,
      orderType: IOrderType.GENERAL,
      blockedRowNos: new Set(),
    })!;
    expect(r.sourceRowNos).toEqual([5]); // 6행은 이메일 없어 제외
  });

  it('예약발송: sendType=RESERVE + KST 벽시계 문자열', () => {
    const rows = [mappedRow(5, p1)];
    const r = builder.build({
      header: header({ isImmediate: false, sendRequestAt: new Date('2026-08-05T14:30:00+09:00') }),
      rows,
      orderType: IOrderType.GENERAL,
      blockedRowNos: new Set(),
    })!;
    const op = r.payload.orderProductList[0];
    expect(op.sendType).toBe('RESERVE');
    expect(op.sendRequestAt).toBe('2026-08-05T14:30:00'); // dateAtRegexp 준수
  });

  it('즉시발송: sendType=IMMEDIATE + sendRequestAt=null', () => {
    const rows = [mappedRow(5, p1)];
    const r = builder.build({
      header: header({ isImmediate: true }),
      rows,
      orderType: IOrderType.GENERAL,
      blockedRowNos: new Set(),
    })!;
    const op = r.payload.orderProductList[0];
    expect(op.sendType).toBe('IMMEDIATE');
    expect(op.sendRequestAt).toBeNull();
  });

  it('대치문자 전달(null → undefined)', () => {
    const rows = [mappedRow(5, p1, { replaceCharacter1: '홍길동', replaceCharacter2: null })];
    const r = builder.build({ header: header(), rows, orderType: IOrderType.GENERAL, blockedRowNos: new Set() })!;
    const d = r.payload.orderProductList[0].orderDeliveryList[0];
    expect(d.replaceCharacter1).toBe('홍길동');
    expect(d.replaceCharacter2).toBeUndefined();
  });

  it('살아남은 행 0이면 null', () => {
    const rows = [mappedRow(5, p1)];
    const r = builder.build({
      header: header(),
      rows,
      orderType: IOrderType.GENERAL,
      blockedRowNos: new Set([5]),
    });
    expect(r).toBeNull();
  });
});
