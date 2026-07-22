import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ProductChoiceGetProductListReqQueryDto } from './product.choice.req.dto';

/**
 * 초이스쿠폰 상품 검색 DTO 의 excludeProductIdList 변환/검증 테스트.
 *
 * 배경: 검색 API 가 이미 등록된 상품을 제외하지 않아, 프론트가 페이징된 결과에서 다시 걸러내고 있었다.
 *      (자른 뒤 제외 → 페이지당 행 수가 들쭉날쭉하고 통째로 빈 페이지가 생김)
 *      제외를 DB 로 옮기기 위해 화면의 등록 목록을 이 파라미터로 받는다.
 *
 * 전역 ValidationPipe({ whitelist:true, transform:true }) 가 컨트롤러 진입 시 하는 변환을 재현한다.
 * 쿼리스트링은 항상 문자열로 도착하므로 변환 규칙 자체가 계약이다.
 */
function toDto(payload: unknown): ProductChoiceGetProductListReqQueryDto {
  return plainToInstance(ProductChoiceGetProductListReqQueryDto, payload, { enableImplicitConversion: false });
}

async function validatePayload(payload: unknown): Promise<string[]> {
  const errors = await validate(toDto(payload) as object, { whitelist: true, forbidUnknownValues: false });
  const flatten = (errs: typeof errors): string[] =>
    errs.flatMap((e) => [...Object.keys(e.constraints ?? {}), ...flatten(e.children ?? [])]);
  return flatten(errors);
}

describe('ProductChoiceGetProductListReqQueryDto.excludeProductIdList 변환', () => {
  it('콤마 구분 문자열을 숫자 배열로 변환한다', () => {
    expect(toDto({ excludeProductIdList: '780,763,729' }).excludeProductIdList).toEqual([780, 763, 729]);
  });

  it('반복 파라미터(?id=780&id=763)로 도착한 배열도 그대로 받는다', () => {
    expect(toDto({ excludeProductIdList: ['780', '763'] }).excludeProductIdList).toEqual([780, 763]);
  });

  it('앞뒤 공백을 무시한다', () => {
    expect(toDto({ excludeProductIdList: ' 780 , 763 ' }).excludeProductIdList).toEqual([780, 763]);
  });

  it('중복 id 는 하나로 합친다', () => {
    expect(toDto({ excludeProductIdList: '780,780,763' }).excludeProductIdList).toEqual([780, 763]);
  });

  it('미전달이면 undefined 로 둔다 (제외 조건 자체가 붙지 않아야 한다)', () => {
    expect(toDto({}).excludeProductIdList).toBeUndefined();
  });

  it('빈 문자열이면 undefined 로 둔다 — 빈 배열이 쿼리에 들어가면 SQL 이 IN () 으로 깨진다', () => {
    expect(toDto({ excludeProductIdList: '' }).excludeProductIdList).toBeUndefined();
  });
});

describe('ProductChoiceGetProductListReqQueryDto.excludeProductIdList 검증', () => {
  it('정상 목록은 통과한다', async () => {
    expect(await validatePayload({ excludeProductIdList: '780,763' })).toEqual([]);
  });

  it('미전달도 통과한다 (선택 파라미터)', async () => {
    expect(await validatePayload({})).toEqual([]);
  });

  it('숫자가 아닌 값은 거부한다', async () => {
    expect(await validatePayload({ excludeProductIdList: '780,abc' })).toContain('isInt');
  });

  it('빈 항목(콤마 연속)은 조용히 버리지 않고 거부한다', async () => {
    expect(await validatePayload({ excludeProductIdList: '780,,763' })).toContain('isInt');
  });

  it('0 이하의 id 는 거부한다', async () => {
    expect(await validatePayload({ excludeProductIdList: '0' })).toContain('min');
  });
});
