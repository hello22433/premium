import { SettleService } from './settle.service';

/**
 * forSum(요약 합계) 정산 쿼리의 컬럼 로드 계약 (197-16).
 *
 * forSum 경로는 표시 컬럼을 생략하는 경량 쿼리라 orderDeliveries 를 명시 컬럼 리스트(addSelect)로만
 * 로드한다. 그 리스트에서 `orderDeliveries.status` 가 빠지면 buildSettlementDisplayLines 의 취소 제외
 * 필터(`delivery.status !== CANCEL`)가 `undefined !== CANCEL` → 항상 true 로 조용히 통과해, 요약 금액이
 * 취소분을 다시 포함한다(상세와 요약이 어긋나고 취소 발송건이 청구에 재산입). 순수 함수
 * (buildSettlementDisplayLines)는 status 가 있는 fixture 로 검증되지만, 그 함수에 status 를 먹여주는
 * 이 쿼리의 select 자체는 여기서 고정한다 — select 라인을 지우면 여기서 깨진다.
 *
 * 쿼리 빌더 체인을 Proxy 로 받아 addSelect 인자를 캡처한다(실행하지 않고 빌드만).
 */
describe('SettleService.buildUserSettleQueryBuilder — forSum 정산금액 계산 컬럼', () => {
  const buildSut = () => {
    const addSelectArgs: unknown[] = [];
    const builder: any = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'addSelect') {
            return (arg: unknown) => {
              addSelectArgs.push(arg);
              return builder;
            };
          }
          return () => builder;
        },
      },
    );
    const sut: any = Object.create(SettleService.prototype);
    sut.orderRepository = { createQueryBuilder: () => builder };
    // 날짜 조건 헬퍼는 빌더를 그대로 통과시킨다(쿼리 실행 없음).
    sut.applySettleUserDateCondition = (qb: any) => qb;
    return { sut, addSelectArgs };
  };

  it('forSum=true 는 orderDeliveries.status 를 select 한다 (취소 제외 필터의 load-bearing 컬럼)', () => {
    const { sut, addSelectArgs } = buildSut();

    sut.buildUserSettleQueryBuilder({}, { forSum: true });

    const selected = addSelectArgs.flat();
    expect(selected).toContain('orderDeliveries.status');
    // 정산금액 계산에 쓰는 다른 컬럼들도 함께 로드되는지(회귀 방지).
    expect(selected).toContain('orderDeliveries.settleFee');
    expect(selected).toContain('orderDeliveries.couponStatus');
    expect(selected).toContain('orderDeliveries.replacedFromId');
  });
});
