import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { OrderDeliveryCancelReqDto } from './order.req.dto';

/**
 * 발송취소 요청 DTO 검증.
 *
 * deliveryIds 는 예약건 부분취소용으로, DTO 단계에서는 **선택값**이다.
 * 다만 서비스가 아직 부분취소를 구현하지 않아, 실제로 이 값을 보내면 서비스 가드에서 400 이
 * 난다(order.service.ts deliveryCancel 진입부). 여기서 통과시키는 것은 "형식이 올바른가" 까지다.
 * 값을 보냈을 때 거부되는지는 order.service.partial-cancel-guard.spec.ts 가 지킨다.
 *
 * 부분취소 전환 커밋에서 이 필드는 필수로 승격되며, 그때 이 스펙의 "미전송 허용" 케이스가
 * "미전송 거부" 로 뒤집힌다 — 승격 시 반드시 함께 갱신할 것.
 */
describe('OrderDeliveryCancelReqDto validation', () => {
  const base = { id: 1001, cancelReason: '고객 요청' };

  const errorsFor = async (payload: Record<string, unknown>) =>
    validate(plainToInstance(OrderDeliveryCancelReqDto, payload));

  const propError = (errors: Awaited<ReturnType<typeof errorsFor>>, prop: string) =>
    errors.find((e) => e.property === prop);

  it('deliveryIds 미전송을 허용한다 (현 단계는 선택값)', async () => {
    const errors = await errorsFor(base);

    expect(propError(errors, 'deliveryIds')).toBeUndefined();
  });

  it('deliveryIds 를 주면 통과한다', async () => {
    const errors = await errorsFor({ ...base, deliveryIds: [9003, 9004, 9005] });

    expect(propError(errors, 'deliveryIds')).toBeUndefined();
  });

  // 선택값이지만 "주면 제대로 줘야 한다". 빈 배열을 허용하면 프론트가 실수로 빈 값을 보냈을 때
  // 의도가 "아무것도 취소 안 함" 인지 "전체 취소" 인지 구분되지 않는다.
  it('deliveryIds 가 빈 배열이면 거부한다', async () => {
    const errors = await errorsFor({ ...base, deliveryIds: [] });

    expect(propError(errors, 'deliveryIds')?.constraints).toHaveProperty('arrayNotEmpty');
  });

  it('deliveryIds 원소가 숫자가 아니면 거부한다', async () => {
    const errors = await errorsFor({ ...base, deliveryIds: ['9003'] as unknown as number[] });

    expect(propError(errors, 'deliveryIds')?.constraints).toHaveProperty('isNumber');
  });

  it('deliveryIds 가 배열이 아니면 거부한다', async () => {
    const errors = await errorsFor({ ...base, deliveryIds: 9003 as unknown as number[] });

    expect(propError(errors, 'deliveryIds')?.constraints).toHaveProperty('isArray');
  });

  it('기존 필수 필드(id, cancelReason) 규칙은 그대로다', async () => {
    const errors = await errorsFor({ deliveryIds: [9003] });

    expect(propError(errors, 'id')).toBeDefined();
    expect(propError(errors, 'cancelReason')).toBeDefined();
  });

  it('cancelReason 1000자 초과는 거부한다', async () => {
    const errors = await errorsFor({ ...base, cancelReason: 'x'.repeat(1001) });

    expect(propError(errors, 'cancelReason')?.constraints).toHaveProperty('maxLength');
  });
});
