import { Brackets, SelectQueryBuilder } from 'typeorm';

/**
 * 고객사별정산 목록의 발행/미발행 필터.
 *
 *   발행   = 두 리포트 중 **하나라도** 발행됨 (OR)
 *   미발행 = 둘 다 미발행 (AND)
 *
 * 두 조건이 서로의 여집합이라 모든 주문이 정확히 한쪽에만 속한다. 이전에는 양쪽 모두 AND 라
 * 한쪽 리포트만 발행된 주문이 발행·미발행 어느 목록에도 잡히지 않고 증발했다. 발송완료리포트와
 * 거래명세서는 발행 엔드포인트가 분리돼 있어 한쪽만 발행하는 것이 정상 동선이다.
 *
 * ⚠️ OR 는 반드시 `andWhere(new Brackets(...))` 로 감싼다. `orWhere` 를 그대로 붙이면 앞서 걸린
 * 기간·상태·검색어 조건까지 OR 로 흡수되어 필터가 통째로 무력화된다. 특히 엑셀 경로는 직전
 * 조건이 `where(status IN ...)` 이라 감싸지 않으면 상태 필터가 사라진다.
 *
 * 목록/요약/ids 공용 QB 와 엑셀 QB 두 곳이 이 함수를 공유한다 — 복붙으로 두면 한쪽만 고쳐져
 * 합계와 목록이 어긋난다.
 */
export function applyIsPublishedFilter<T extends SelectQueryBuilder<any>>(qb: T, isPublished?: boolean): T {
  if (isPublished === true) {
    qb.andWhere(
      new Brackets((inner: SelectQueryBuilder<any>) => {
        inner.where('order.deliveryCompleteReportCount > 0').orWhere('order.orderCompleteReportCount > 0');
      }),
    );
  }

  if (isPublished === false) {
    qb.andWhere('order.deliveryCompleteReportCount = 0');
    qb.andWhere('order.orderCompleteReportCount = 0');
  }

  return qb;
}
