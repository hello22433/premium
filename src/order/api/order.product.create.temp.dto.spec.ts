import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { OrderProductCreateTempDto } from './dto/order.product.create.temp.dto';

describe('OrderProductCreateTempDto validation', () => {
  const base = {
    productId: 1,
    amount: 1,
    orderDeliveryList: [{ deliveryTarget: '01012345678' }],
  };

  it.each([
    ['negative amount', -1],
    ['zero amount', 0],
    ['decimal amount', 1.5],
  ])('rejects %s', async (_caseName, amount) => {
    const dto = plainToInstance(OrderProductCreateTempDto, { ...base, amount });

    const errors = await validate(dto);

    const target = errors.find((e) => e.property === 'amount');
    expect(target).toBeDefined();
  });

  it('accepts positive integer amount', async () => {
    const dto = plainToInstance(OrderProductCreateTempDto, base);

    const errors = await validate(dto);

    expect(errors.find((e) => e.property === 'amount')).toBeUndefined();
  });
});
