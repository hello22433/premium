import { ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { endOfDay, format, parseISO, startOfDay } from 'date-fns';

export const QueryBuilderDateCondition = <T extends ObjectLiteral>(
  queryBuilder: SelectQueryBuilder<T>,
  alias: string,
  columnName: string,
  startAt: string | undefined,
  endAt: string | undefined,
): SelectQueryBuilder<T> => {
  // 파라미터 이름이 충돌나지 않도록 컬럼명을 포함시킨 키 생성 (예: proveAtStartAt)
  const startKey = `${columnName}StartAt`;
  const endKey = `${columnName}EndAt`;

  if (startAt && endAt) {
    queryBuilder = queryBuilder.andWhere(`${alias}.${columnName} >= :${startKey}`, {
      [startKey]: format(startOfDay(parseISO(startAt)), 'yyyy-MM-dd HH:mm:ss'),
    });
    queryBuilder = queryBuilder.andWhere(`${alias}.${columnName} <= :${endKey}`, {
      [endKey]: format(endOfDay(parseISO(endAt)), 'yyyy-MM-dd HH:mm:ss'),
    });
  }

  if (startAt && !endAt) {
    queryBuilder = queryBuilder.andWhere(`${alias}.${columnName} >= :${startKey}`, {
      [startKey]: format(startOfDay(parseISO(startAt)), 'yyyy-MM-dd HH:mm:ss'),
    });
  }

  if (!startAt && endAt) {
    queryBuilder = queryBuilder.andWhere(`${alias}.${columnName} <= :${endKey}`, {
      [endKey]: format(endOfDay(parseISO(endAt)), 'yyyy-MM-dd HH:mm:ss'),
    });
  }

  return queryBuilder;
};
