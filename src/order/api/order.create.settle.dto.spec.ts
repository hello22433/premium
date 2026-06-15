import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { OrderCreateSettleReqDto } from './order.req.dto';

// cardSurchargeApplied / settleMethod 입력 검증 (강제 결합 제거 후 독립 필드).
describe('OrderCreateSettleReqDto validation', () => {
  const base = { list: [{ id: 1 }] };

  it('cardSurchargeApplied 가 "false" 문자열이면 거부한다 (truthy 오계산 방지)', async () => {
    const dto = plainToInstance(OrderCreateSettleReqDto, { ...base, cardSurchargeApplied: 'false' });
    const errors = await validate(dto);
    const target = errors.find((e) => e.property === 'cardSurchargeApplied');
    expect(target).toBeDefined();
    expect(target!.constraints).toHaveProperty('isBoolean');
  });

  it('cardSurchargeApplied 가 실제 boolean 이면 통과한다', async () => {
    const dto = plainToInstance(OrderCreateSettleReqDto, { ...base, cardSurchargeApplied: false });
    const errors = await validate(dto);
    expect(errors.find((e) => e.property === 'cardSurchargeApplied')).toBeUndefined();
  });

  it('settleMethod 는 CARD|CASH 만 허용한다', async () => {
    const dto = plainToInstance(OrderCreateSettleReqDto, { ...base, settleMethod: 'TRANSFER' });
    const errors = await validate(dto);
    expect(errors.find((e) => e.property === 'settleMethod')).toBeDefined();
  });

  it('두 필드 모두 미전송이어도 통과한다 (선택적)', async () => {
    const dto = plainToInstance(OrderCreateSettleReqDto, { ...base });
    const errors = await validate(dto);
    expect(errors.find((e) => e.property === 'cardSurchargeApplied')).toBeUndefined();
    expect(errors.find((e) => e.property === 'settleMethod')).toBeUndefined();
  });
});
