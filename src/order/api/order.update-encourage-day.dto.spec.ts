import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { OrderUpdateEncourageDayReqBodyDto } from './order.req.dto';

const validateDto = async (payload: Record<string, unknown>) => {
  const dto = plainToInstance(OrderUpdateEncourageDayReqBodyDto, payload, { enableImplicitConversion: false });
  return validate(dto, { whitelist: true, forbidUnknownValues: false });
};

const constraintsOf = async (payload: Record<string, unknown>) => {
  const errors = await validateDto(payload);
  return errors.flatMap((error) => Object.keys(error.constraints ?? {}));
};

describe('OrderUpdateEncourageDayReqBodyDto validation', () => {
  it.each([
    ['누락', {}],
    ['미사용 null', { encourageDay: null }],
    ['당일 0', { encourageDay: 0 }],
    ['양의 정수', { encourageDay: 3 }],
  ])('%s 입력을 허용한다', async (_name, payload) => {
    await expect(validateDto(payload)).resolves.toHaveLength(0);
  });

  it('음수 독려일을 거부한다', async () => {
    await expect(constraintsOf({ encourageDay: -1 })).resolves.toContain('min');
  });

  it('소수 독려일을 거부한다', async () => {
    await expect(constraintsOf({ encourageDay: 1.5 })).resolves.toContain('isInt');
  });
});
