import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CustomerServiceHistoryReqDto, CS_HISTORY_TYPES } from './customer.service.req.dto';

/**
 * M-3 회귀 테스트 — CS 이력(order_history) type 의 허용값 강제(@IsIn).
 *
 * 결함(리스크): type 이 @IsString 만이라 enum 미강제 매직스트링. 프론트·백엔드가 같은 한글
 *      문자열에 의존하나 강제 장치가 없어, 오타/리네임 시 type 기반 분기(특히 조기파기 C-1
 *      type 필터)가 조용히 빗나갈 수 있었다.
 * 수정: 유효 type 단일 소스 CS_HISTORY_TYPES + @IsIn 으로 검증 진입 시점에 차단.
 *
 * 전역 ValidationPipe({ whitelist:true, transform:true }) 검증을 재현한다.
 */
async function validatePayload<T extends object>(cls: new () => T, payload: unknown): Promise<string[]> {
  const instance = plainToInstance(cls, payload, { enableImplicitConversion: false });
  const errors = await validate(instance as object, { whitelist: true, forbidUnknownValues: false });
  const flatten = (errs: typeof errors): string[] =>
    errs.flatMap((e) => [...Object.keys(e.constraints ?? {}), ...flatten(e.children ?? [])]);
  return flatten(errors);
}

describe('CustomerServiceHistoryReqDto.type 검증 (M-3 @IsIn)', () => {
  it.each([...CS_HISTORY_TYPES])('유효 type "%s" 은 통과한다', async (type) => {
    expect(await validatePayload(CustomerServiceHistoryReqDto, { orderDeliveryId: 1, type })).toEqual([]);
  });

  it('정의되지 않은 type 은 거부한다 (isIn) — M-3 핵심', async () => {
    expect(await validatePayload(CustomerServiceHistoryReqDto, { orderDeliveryId: 1, type: '해킹시도' })).toContain(
      'isIn',
    );
  });

  it("별도 엔드포인트 소관인 '핀상태 변경' 은 이 DTO 에선 거부한다", async () => {
    expect(
      await validatePayload(CustomerServiceHistoryReqDto, { orderDeliveryId: 1, type: '핀상태 변경' }),
    ).toContain('isIn');
  });

  it('type 누락은 통과한다(@IsOptional) — 누락 안내는 service 책임', async () => {
    expect(await validatePayload(CustomerServiceHistoryReqDto, { orderDeliveryId: 1 })).toEqual([]);
  });

  it('CS_HISTORY_TYPES 는 6개 유효 유형으로 고정된다', () => {
    expect([...CS_HISTORY_TYPES]).toEqual([
      '단순문의',
      '재전송',
      '수신정보 변경요청',
      '폐기',
      '환불폐기',
      '폐기 후 신규 발송',
    ]);
  });
});
