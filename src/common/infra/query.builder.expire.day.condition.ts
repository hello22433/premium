import { ObjectLiteral, SelectQueryBuilder } from 'typeorm';

/**
 * 유효기간(일) 범위 필터 공통 조건 — 한쪽만 전송 시 단방향(열린 경계), 둘 다 전송 시 BETWEEN 과 동일.
 *
 * columnExpr 로 대상 컬럼 표현식을 받아 상품목록('product.expireDay')과
 * CS 목록('COALESCE(choiceSelectProduct.expireDay, product.expireDay)' — 초이스쿠폰은
 * 선택된 상품 기준) 양쪽에서 재사용한다.
 *
 * 입력 검증(min > max 이면 400)은 이 함수 소관이 아니므로, 호출부에서
 * assertExpireDayRangeValid(expire.util.ts) 를 쿼리 조립 전에 먼저 호출할 것.
 */
export const QueryBuilderExpireDayCondition = <T extends ObjectLiteral>(
  queryBuilder: SelectQueryBuilder<T>,
  columnExpr: string,
  expireDayMin: number | undefined,
  expireDayMax: number | undefined,
): SelectQueryBuilder<T> => {
  if (expireDayMin !== undefined) {
    queryBuilder = queryBuilder.andWhere(`${columnExpr} >= :expireDayMin`, { expireDayMin });
  }

  if (expireDayMax !== undefined) {
    queryBuilder = queryBuilder.andWhere(`${columnExpr} <= :expireDayMax`, { expireDayMax });
  }

  return queryBuilder;
};
