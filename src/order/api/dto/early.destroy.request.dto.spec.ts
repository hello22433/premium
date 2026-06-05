import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateEarlyDestroyRequestDto,
  CreateDeliveriesEarlyDestroyRequestDto,
} from './early.destroy.request.dto';

/**
 * M-1 회귀 테스트 — 조기파기 요청 DTO 의 빈 배열 검증.
 *
 * 결함: CreateEarlyDestroyRequestDto.orderProductMappingIds 가 @IsNotEmpty 였는데,
 *      class-validator 의 isNotEmpty 는 빈 배열 []을 "비어있음"으로 보지 않아 통과시켰다.
 *      → @ArrayNotEmpty 로 교체해 []을 거부한다. (형제 DTO CreateDeliveries...와 동일 정책)
 *
 * 전역 ValidationPipe({ whitelist:true, transform:true }) 가 컨트롤러 진입 시 하는 검증을 재현한다.
 * (서비스 유닛테스트는 DTO 검증을 우회하므로, 잘못된 payload 차단은 여기서만 증명된다.)
 */
async function validatePayload<T extends object>(cls: new () => T, payload: unknown): Promise<string[]> {
  const instance = plainToInstance(cls, payload, { enableImplicitConversion: false });
  const errors = await validate(instance as object, { whitelist: true, forbidUnknownValues: false });
  const flatten = (errs: typeof errors): string[] =>
    errs.flatMap((e) => [...Object.keys(e.constraints ?? {}), ...flatten(e.children ?? [])]);
  return flatten(errors);
}

describe('CreateEarlyDestroyRequestDto 검증 (M-1)', () => {
  it('정상 id 배열은 통과한다', async () => {
    expect(await validatePayload(CreateEarlyDestroyRequestDto, { orderProductMappingIds: [1, 2, 3] })).toEqual([]);
  });

  it('빈 배열 []은 거부한다 (arrayNotEmpty) — M-1 핵심', async () => {
    expect(await validatePayload(CreateEarlyDestroyRequestDto, { orderProductMappingIds: [] })).toContain(
      'arrayNotEmpty',
    );
  });

  it('배열이 아니면 거부한다 (isArray)', async () => {
    expect(await validatePayload(CreateEarlyDestroyRequestDto, { orderProductMappingIds: 1 })).toContain('isArray');
  });

  it('숫자가 아닌 원소는 거부한다 (isNumber)', async () => {
    expect(await validatePayload(CreateEarlyDestroyRequestDto, { orderProductMappingIds: ['a'] })).toContain(
      'isNumber',
    );
  });

  it('선택 메타필드(고객사 등)는 없어도 통과한다', async () => {
    expect(
      await validatePayload(CreateEarlyDestroyRequestDto, { orderProductMappingIds: [10], clientCompany: '이앤매드' }),
    ).toEqual([]);
  });
});

describe('CreateDeliveriesEarlyDestroyRequestDto 검증 (형제 DTO 대조)', () => {
  it('정상 id 배열은 통과한다', async () => {
    expect(await validatePayload(CreateDeliveriesEarlyDestroyRequestDto, { orderDeliveryIds: [1, 2] })).toEqual([]);
  });

  it('빈 배열 []은 거부한다 (arrayNotEmpty)', async () => {
    expect(await validatePayload(CreateDeliveriesEarlyDestroyRequestDto, { orderDeliveryIds: [] })).toContain(
      'arrayNotEmpty',
    );
  });
});
