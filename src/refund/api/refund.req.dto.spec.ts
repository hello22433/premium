import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RefundResetBatchReqDto, RefundUpdateBatchReqDto } from './refund.req.dto';
import { OrderDeliveryRefundStatusEnum } from '../../delivery/interface/order.delivery.refund.status.enum';

/**
 * 전역 ValidationPipe({ whitelist: true, transform: true }) 가 컨트롤러 진입 시 하는 일을 그대로 재현한다.
 * (서비스 유닛테스트는 DTO 검증을 우회하므로, 잘못된 payload 가 막히는지는 여기서만 증명된다.)
 */
async function validatePayload<T extends object>(cls: new () => T, payload: unknown): Promise<string[]> {
  const instance = plainToInstance(cls, payload, { enableImplicitConversion: false });
  const errors = await validate(instance as object, { whitelist: true, forbidUnknownValues: false });
  // 중첩 에러까지 평탄화해서 어떤 제약이 깨졌는지 키로 수집
  const flatten = (errs: typeof errors): string[] =>
    errs.flatMap((e) => [...Object.keys(e.constraints ?? {}), ...flatten(e.children ?? [])]);
  return flatten(errors);
}

describe('RefundResetBatchReqDto 검증', () => {
  it('정상 id 배열은 통과한다', async () => {
    expect(await validatePayload(RefundResetBatchReqDto, { ids: [1, 2, 3] })).toEqual([]);
  });

  it('빈 배열은 거부한다 (ArrayMinSize)', async () => {
    expect(await validatePayload(RefundResetBatchReqDto, { ids: [] })).toContain('arrayMinSize');
  });

  it('501개 초과는 거부한다 (ArrayMaxSize)', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => i + 1);
    expect(await validatePayload(RefundResetBatchReqDto, { ids })).toContain('arrayMaxSize');
  });

  it('정수가 아니면 거부한다 (IsInt)', async () => {
    expect(await validatePayload(RefundResetBatchReqDto, { ids: [1, 2.5] })).toContain('isInt');
  });

  it('0/음수는 거부한다 (IsPositive)', async () => {
    expect(await validatePayload(RefundResetBatchReqDto, { ids: [1, 0, -3] })).toContain('isPositive');
  });

  it('숫자가 아닌 값(문자열)은 거부한다', async () => {
    const broken = await validatePayload(RefundResetBatchReqDto, { ids: ['abc'] });
    expect(broken.length).toBeGreaterThan(0);
  });

  it('ids 자체가 배열이 아니면 거부한다 (IsArray)', async () => {
    expect(await validatePayload(RefundResetBatchReqDto, { ids: 1 })).toContain('isArray');
  });
});

describe('RefundUpdateBatchReqDto 중첩 검증', () => {
  const validItem = {
    id: 1,
    refundStatus: OrderDeliveryRefundStatusEnum.APPROVE,
    bankName: '국민',
    bankAccount: '123-456',
    bankAccountOwner: '홍길동',
    approveAt: '2026-06-02T00:00:00',
  };

  it('정상 items는 통과한다', async () => {
    expect(await validatePayload(RefundUpdateBatchReqDto, { items: [validItem] })).toEqual([]);
  });

  it('빈 items 배열은 거부한다 (ArrayMinSize)', async () => {
    expect(await validatePayload(RefundUpdateBatchReqDto, { items: [] })).toContain('arrayMinSize');
  });

  it('중첩 항목의 잘못된 refundStatus는 거부한다 (IsEnum, ValidateNested 동작 증명)', async () => {
    const bad = { ...validItem, refundStatus: 'NOPE' };
    expect(await validatePayload(RefundUpdateBatchReqDto, { items: [bad] })).toContain('isEnum');
  });

  it('중첩 항목의 bankAccount가 비면 거부한다 (IsNotEmpty)', async () => {
    const bad = { ...validItem, bankAccount: '' };
    expect(await validatePayload(RefundUpdateBatchReqDto, { items: [bad] })).toContain('isNotEmpty');
  });

  it('중첩 항목의 잘못된 날짜 형식은 거부한다 (Matches)', async () => {
    const bad = { ...validItem, approveAt: '2026/06/02' };
    expect(await validatePayload(RefundUpdateBatchReqDto, { items: [bad] })).toContain('matches');
  });

  it('중첩 항목의 음수 id는 거부한다 (IsPositive)', async () => {
    const bad = { ...validItem, id: -1 };
    expect(await validatePayload(RefundUpdateBatchReqDto, { items: [bad] })).toContain('isPositive');
  });

  it('items가 객체 배열이 아니면 거부한다', async () => {
    const broken = await validatePayload(RefundUpdateBatchReqDto, { items: [1, 2] });
    expect(broken.length).toBeGreaterThan(0);
  });
});
