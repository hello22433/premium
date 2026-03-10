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
    // 길이가 10(YYYY-MM-DD)이면 시작 시간(00:00:00)을 직접 명시, 시간이 포함되어 들어오면 원래의 시간을 존중
    const formattedStart = startAt.length === 10 ? `${startAt} 00:00:00` : startAt.replace('T', ' ').replace('Z', '');

    queryBuilder = queryBuilder.andWhere(`${alias}.${columnName} >= :${startKey}`, {
      [startKey]: formattedStart,
    });
  }

  if (endAt) {
    // 길이가 10(YYYY-MM-DD)이면 마지막 시간(23:59:59.999)으로 확장, 시간이 포함된 경우는 명시된 종료 시간을 존중
    const formattedEnd = endAt.length === 10 ? `${endAt} 23:59:59.999` : endAt.replace('T', ' ').replace('Z', '');

    queryBuilder = queryBuilder.andWhere(`${alias}.${columnName} <= :${endKey}`, {
      [endKey]: formattedEnd,
    });
  }

  return queryBuilder;
};
