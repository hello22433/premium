import { BadRequestException } from '@nestjs/common';
import { QueryBuilderExpireDayCondition } from './query.builder.expire.day.condition';
import { assertExpireDayRangeValid } from '../utils/expire.util';

/**
 * 유효기간(일) 범위 필터 공통 헬퍼 테스트.
 * 상품목록(product.service.ts)·CS목록(customer.service.service.ts) 4개 호출부가 공유하는
 * 가드(assertExpireDayRangeValid) + WHERE 조건(QueryBuilderExpireDayCondition) 검증.
 */

describe('assertExpireDayRangeValid', () => {
  it('min > max 이면 BadRequestException 을 던진다', () => {
    expect(() => assertExpireDayRangeValid(61, 59)).toThrow(BadRequestException);
  });

  it.each([
    [59, 61],
    [60, 60], // 동일값 허용
    [undefined, 61], // 한쪽만
    [59, undefined],
    [undefined, undefined], // 미전송
  ])('min=%p, max=%p 는 통과한다', (min, max) => {
    expect(() => assertExpireDayRangeValid(min as any, max as any)).not.toThrow();
  });
});

describe('QueryBuilderExpireDayCondition', () => {
  const buildQb = () => {
    const qb: any = {};
    qb.andWhere = jest.fn().mockReturnValue(qb);
    return qb;
  };

  it('min/max 모두 전송 시 컬럼 표현식 기반 범위 조건 2개를 적용한다', () => {
    const qb = buildQb();
    QueryBuilderExpireDayCondition(qb, 'product.expireDay', 59, 61);

    expect(qb.andWhere).toHaveBeenCalledWith('product.expireDay >= :expireDayMin', { expireDayMin: 59 });
    expect(qb.andWhere).toHaveBeenCalledWith('product.expireDay <= :expireDayMax', { expireDayMax: 61 });
  });

  it('COALESCE 등 임의 컬럼 표현식을 그대로 사용한다 (CS 초이스쿠폰 케이스)', () => {
    const qb = buildQb();
    const expr = 'COALESCE(choiceSelectProduct.expireDay, product.expireDay)';
    QueryBuilderExpireDayCondition(qb, expr, 1824, 1826);

    expect(qb.andWhere).toHaveBeenCalledWith(`${expr} >= :expireDayMin`, { expireDayMin: 1824 });
    expect(qb.andWhere).toHaveBeenCalledWith(`${expr} <= :expireDayMax`, { expireDayMax: 1826 });
  });

  it('한쪽만 전송 시 해당 조건만 적용한다 (열린 경계)', () => {
    const qb = buildQb();
    QueryBuilderExpireDayCondition(qb, 'product.expireDay', 59, undefined);

    expect(qb.andWhere).toHaveBeenCalledTimes(1);
    expect(qb.andWhere).toHaveBeenCalledWith('product.expireDay >= :expireDayMin', { expireDayMin: 59 });
  });

  it('미전송 시 조건을 추가하지 않고 queryBuilder 를 그대로 반환한다', () => {
    const qb = buildQb();
    const returned = QueryBuilderExpireDayCondition(qb, 'product.expireDay', undefined, undefined);

    expect(qb.andWhere).not.toHaveBeenCalled();
    expect(returned).toBe(qb);
  });
});
