import { OrderService } from './order.service';

/**
 * 부분취소 정산금액 재계산 로더의 **조인 계약** (197-16, 리뷰 HIGH).
 *
 * 이 로더가 product 를 innerJoin 으로 되돌아가면 다음이 벌어진다:
 *   주문 이후 상품이 소프트삭제됨(ProductEntity 는 BaseEntity 의 @DeleteDateColumn 보유)
 *   → TypeORM 이 조인에 deleted_at IS NULL 을 걸어 **그 매핑 행이 결과에서 사라짐**
 *   → calculateOrderSettlementAmount 가 그 몫을 0 으로 세어 settleAmount 가 과소(전부 삭제면 0) 저장
 *   → 이후 **전체취소**가 신흐름에서 그 값을 그대로 환불액으로 읽고(refundAmount = order.settleAmount)
 *     `refundAmount > 0 && isWalletManaged(...)` 단락평가로 wallet 환불 경로 자체를 건너뜀
 *   → 취소는 되고 **환불은 0원**. allocation.released_at 도 NULL 로 남아 사후 스윕이 못 잡는다.
 *
 * 계산 쪽(readLineProductView: snapshotProductPrice ?? product?.price ?? 0)은 상품이 없어도
 * 스냅샷으로 복원할 수 있으므로, **매핑 행만 남겨 주면**(leftJoin) 금액이 정확히 나온다.
 * 즉 이 파일이 지키는 것은 "행을 떨어뜨리지 않는다" 는 한 가지다.
 *
 * 부분취소 스펙(order.service.partial-cancel.spec.ts)은 이 로더를 **모킹**하므로 조인 타입을
 * 볼 수 없다 — innerJoin 으로 되돌려도 그쪽은 전부 통과한다. 그래서 여기서 따로 고정한다.
 *
 * 쿼리 빌더 체인을 Proxy 로 받아 조인 호출을 캡처한다(실행하지 않고 빌드만).
 */
describe('OrderService.getOrderProductsForCancelSettlement — 조인 계약', () => {
  const buildSut = () => {
    const joins: Array<{ kind: string; relation: string }> = [];
    const builder: any = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'leftJoinAndSelect' || prop === 'innerJoinAndSelect') {
            return (relation: string) => {
              joins.push({ kind: String(prop), relation });
              return builder;
            };
          }
          if (prop === 'getMany') return async () => [];
          return () => builder;
        },
      },
    );
    const sut: any = Object.create(OrderService.prototype);
    sut.orderProductMappingRepository = { createQueryBuilder: () => builder };
    return { sut, joins };
  };

  it('product 를 leftJoin 한다 — 소프트삭제된 상품의 매핑 행을 떨어뜨리지 않는다', async () => {
    const { sut, joins } = buildSut();

    await sut.getOrderProductsForCancelSettlement(1001);

    expect(joins).toContainEqual({ kind: 'leftJoinAndSelect', relation: 'orderProductMapping.product' });
    // ★ 이 단언이 이 파일의 존재 이유다. innerJoin 이면 삭제 상품 매핑이 사라져 정산금액이 과소가 된다.
    expect(joins).not.toContainEqual({ kind: 'innerJoinAndSelect', relation: 'orderProductMapping.product' });
  });

  it('orderDeliveries 를 함께 로드한다 — 미로드 시 취소분이 반영되지 않은 금액이 조용히 나온다', async () => {
    const { sut, joins } = buildSut();

    await sut.getOrderProductsForCancelSettlement(1001);

    // buildSettlementDisplayLines 는 mapping.orderDeliveries 로 취소건을 빼고 차등요율을 판정한다.
    // 미로드면 균일 분기로 빠져 settleFee 를 무시한 틀린 금액이 에러 없이 계산된다
    // (calculateMappingSettlementBaseAmount 의 docstring 이 명시하는 함정).
    expect(joins.map((join) => join.relation)).toContain('orderProductMapping.orderDeliveries');
  });
});
