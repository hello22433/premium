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
    // 프론트엔드 및 DTO 규격에서 시간(yyyy-MM-ddTHH:mm:ss)을 포함하여 보내므로 명시된 시간을 존중
    const formattedStart = startAt.replace('T', ' ');

    queryBuilder = queryBuilder.andWhere(`${alias}.${columnName} >= :${startKey}`, {
      [startKey]: formattedStart,
    });
  }

  if (endAt) {
    // 프론트엔드 및 DTO 규격에서 시간(yyyy-MM-ddTHH:mm:ss)을 포함하여 보내므로 명시된 시간을 존중
    const formattedEnd = endAt.replace('T', ' ');

    queryBuilder = queryBuilder.andWhere(`${alias}.${columnName} <= :${endKey}`, {
      [endKey]: formattedEnd,
    });
  }

  return queryBuilder;
};
