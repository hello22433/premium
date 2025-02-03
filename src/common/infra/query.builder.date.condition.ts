import { ObjectLiteral, SelectQueryBuilder } from 'typeorm';

export const QueryBuilderDateCondition = <T extends ObjectLiteral>(
  queryBuilder: SelectQueryBuilder<T>,
  alias: string,
  columnName: string,
  startAt: string | undefined,
  endAt: string | undefined,
): SelectQueryBuilder<T> => {
  if (startAt && endAt) {
    queryBuilder = queryBuilder.andWhere(`${alias}.${columnName} >= :startAt`, {
      startAt: new Date(startAt),
    });
    queryBuilder = queryBuilder.andWhere(`${alias}.${columnName} <= :endAt`, {
      endAt: new Date(endAt),
    });
  }

  if (startAt && !endAt) {
    queryBuilder = queryBuilder.andWhere(`${alias}.${columnName} >= :startAt`, {
      startAt: new Date(startAt),
    });
  }

  if (!startAt && endAt) {
    queryBuilder = queryBuilder.andWhere(`${alias}.${columnName} <= :endAt`, {
      endAt: new Date(endAt),
    });
  }

  return queryBuilder;
};
