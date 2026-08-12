import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { OrderProductCreateTempDto } from './dto/order.product.create.temp.dto';

describe('OrderProductCreateTempDto validation', () => {
  const base = {
    productId: 1,
    amount: 1,
    orderDeliveryList: [{ deliveryTarget: '01012345678' }],
  };

  // 수량 범위/정수 검증은 서비스 레벨(OrderService.assertPositiveIntegerAmounts)로 이관됨.
  // 서비스에서 상품 순번/상품명이 포함된 한글 메시지를 내려주므로,
  // DTO 단계에서 amount < 1 / 소수를 선차단하면 안 된다(선차단 시 영어 원문 메시지가 노출됨).
  it.each([
    ['negative amount', -1],
    ['zero amount', 0],
    ['decimal amount', 1.5],
  ])('does not reject %s at DTO level (validated in service layer)', async (_caseName, amount) => {
    const dto = plainToInstance(OrderProductCreateTempDto, { ...base, amount });

    const errors = await validate(dto);

    expect(errors.find((e) => e.property === 'amount')).toBeUndefined();
  });

  it('rejects non-numeric amount', async () => {
    const dto = plainToInstance(OrderProductCreateTempDto, {
      ...base,
      amount: 'not-a-number' as unknown as number,
    });

    const errors = await validate(dto);

    expect(errors.find((e) => e.property === 'amount')).toBeDefined();
  });

  it('accepts positive integer amount', async () => {
    const dto = plainToInstance(OrderProductCreateTempDto, base);

    const errors = await validate(dto);

    expect(errors.find((e) => e.property === 'amount')).toBeUndefined();
  });
});

describe('memo normalization', () => {
  const build = (memo: unknown) =>
    plainToInstance(OrderProductCreateTempDto, {
      productId: 1,
      amount: 1,
      orderDeliveryList: [{ deliveryTarget: '01012345678', memo }],
    });

  it('trims before applying the 500 character limit', async () => {
    const dto = build(`  ${'a'.repeat(500)}  `);

    expect(dto.orderDeliveryList[0].memo).toHaveLength(500);
    expect(await validate(dto)).toHaveLength(0);
  });

  it('normalizes blank input to null', async () => {
    const dto = build('   ');

    expect(dto.orderDeliveryList[0].memo).toBeNull();
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects 501 normalized characters', async () => {
    const errors = await validate(build('a'.repeat(501)));
    const nestedErrors = errors.find((error) => error.property === 'orderDeliveryList')?.children?.[0]?.children;

    expect(nestedErrors?.find((error) => error.property === 'memo')).toBeDefined();
  });

  it.each(['line1\nline2', 'line1\rline2'])('rejects line breaks before trim: %j', (memo) => {
    expect(() => build(memo)).toThrow('memo must be a single line');
  });
});
