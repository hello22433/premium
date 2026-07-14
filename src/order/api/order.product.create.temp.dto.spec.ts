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
