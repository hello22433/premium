import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { OrderDeliveryCancelReqDto } from './order.req.dto';

/**
 * 발송취소 요청 DTO 검증.
 *
 * deliveryIds 는 예약건 부분취소용으로, DTO 단계에서는 **선택값**이다 — 생략이 곧 "주문 전체취소"
 * 라는 기존 계약이라 필수로 승격할 수 없다. 여기서 검증하는 것은 "형식이 올바른가" 까지고,
 * 취소 가능 여부(발송 상태·소속 주문·컷오프) 판정은 order.service.partial-cancel.spec.ts 가 지킨다.
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

    // @IsNumber 에서 @IsInt 로 강화되면서 제약 이름이 isNumber → isInt 로 바뀌었다.
    expect(propError(errors, 'deliveryIds')?.constraints).toHaveProperty('isInt');
  });

  it('deliveryIds 가 배열이 아니면 거부한다', async () => {
    const errors = await errorsFor({ ...base, deliveryIds: 9003 as unknown as number[] });

    expect(propError(errors, 'deliveryIds')?.constraints).toHaveProperty('isArray');
  });

  // ★ 중복은 단순한 입력 위생 문제가 아니다.
  // 취소 실행은 조건부 UPDATE 의 affected 를 요청 건수와 비교해 발송배치와의 경합을 판정하는데,
  // SQL 의 IN 은 집합이라 중복을 접는다. [9003, 9003, 9004] → 요청 3 / affected 2 →
  // 아무 문제 없는 취소가 "경합" 으로 판정돼 롤백되고, 재시도해도 영원히 같은 결과다.
  // 로그에도 경합으로 찍혀 진짜 경합과 구분되지 않는다.
  it('deliveryIds 에 중복이 있으면 거부한다 — 가짜 경합 판정을 만든다', async () => {
    const errors = await errorsFor({ ...base, deliveryIds: [9003, 9003, 9004] });

    expect(propError(errors, 'deliveryIds')?.constraints).toHaveProperty('arrayUnique');
  });

  // 아래 세 가지는 전부 "매칭 0건" 이 되어 위와 같은 가짜 경합으로 수렴한다.
  it.each([
    ['음수', [-1]],
    ['0', [0]],
  ])('deliveryIds 원소가 %s 이면 거부한다', async (_caseName, deliveryIds) => {
    const errors = await errorsFor({ ...base, deliveryIds });

    expect(propError(errors, 'deliveryIds')?.constraints).toHaveProperty('min');
  });

  it('deliveryIds 원소가 소수이면 거부한다', async () => {
    const errors = await errorsFor({ ...base, deliveryIds: [9003.7] });

    expect(propError(errors, 'deliveryIds')?.constraints).toHaveProperty('isInt');
  });

  it('deliveryIds 길이 상한을 넘으면 거부한다 — 초대형 IN 절·400 메시지 폭발 차단', async () => {
    const errors = await errorsFor({ ...base, deliveryIds: Array.from({ length: 1001 }, (_, i) => i + 1) });

    expect(propError(errors, 'deliveryIds')?.constraints).toHaveProperty('arrayMaxSize');
  });

  it('상한 이내의 큰 목록은 허용한다', async () => {
    const errors = await errorsFor({ ...base, deliveryIds: Array.from({ length: 1000 }, (_, i) => i + 1) });

    expect(propError(errors, 'deliveryIds')).toBeUndefined();
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
