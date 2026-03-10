import { ObjectLiteral, SelectQueryBuilder } from 'typeorm';

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

  if (startAt) {
    const startDate = new Date(startAt);
    // startAt은 00:00:00 그대로 사용해도 무방합니다.

    queryBuilder = queryBuilder.andWhere(`${alias}.${columnName} >= :${startKey}`, {
      [startKey]: startDate,
    });
  }

  if (endAt) {
    const endDate = new Date(endAt);
    // endAt은 해당 날짜의 23:59:59.999 로 강제 조정하여 마지막 날까지 온전히 포함되도록 합니다.
    endDate.setHours(23, 59, 59, 999);

    queryBuilder = queryBuilder.andWhere(`${alias}.${columnName} <= :${endKey}`, {
      [endKey]: endDate,
    });
  }

  return queryBuilder;
};
