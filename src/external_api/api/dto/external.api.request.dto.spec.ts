import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateExternalSsgOrderDto } from './external.api.request.dto';

describe('CreateExternalSsgOrderDto', () => {
  const makeDto = (amount: unknown) =>
    plainToInstance(CreateExternalSsgOrderDto, {
      recipientPhone: '01012345678',
      amount,
      senderPhone: '0212345678',
      message: '테스트 메시지',
    });

  it.each([5000, 10000, 2000000])('%s원은 SSG 외부 API 주문 금액으로 허용된다', async (amount) => {
    const dto = makeDto(amount);

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });

  it.each([0, 1, 4999, 2000001, 12345, 5000.5, -5000])(
    '%s원은 SSG 외부 API 주문 금액으로 허용되지 않는다',
    async (amount) => {
      const dto = makeDto(amount);

      const errors = await validate(dto);

      expect(errors.some((error) => error.property === 'amount')).toBe(true);
    },
  );

  it('문자열 숫자 5000은 숫자로 변환된 뒤 SSG 외부 API 주문 금액으로 허용된다', async () => {
    const dto = makeDto('5000');

    const errors = await validate(dto);

    expect(dto.amount).toBe(5000);
    expect(errors).toHaveLength(0);
  });
});
