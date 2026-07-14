import { OrderService } from './order.service';

/**
 * '폐기 후 신규 발송'(discard-then-reissue) 고객 노출 정합 회귀 테스트.
 *
 * 배경: 폐기 후 신규 발송 시 order_delivery 에 신규 행(replacedFromId = 원본 id)이 하나 더 생기고
 *       원본은 couponStatus=CANCEL 로만 바뀌어(soft-delete/ status 변경 없음) 그대로 남는다.
 *       그 결과 발송상세/발송완료리포트가 delivery 행 단위로 순회하면 1건이어야 할 발송이 2건으로 표시됐다.
 *       폐기후신규발송은 자사↔수신자 간 내부 처리라 고객사에는 최초 발송 1건만 보여야 한다.
 *
 * 가드: hideDiscardReissueDeliveries 가 replacedFromId != null 인 신규 건을 목록에서 제거하고
 *       최초 발송 건(replacedFromId == null)만 남기는지 검증.
 */
describe('OrderService — 폐기 후 신규 발송 고객 노출 필터 (hideDiscardReissueDeliveries)', () => {
  const sut = Object.create(OrderService.prototype) as any;
  const hide = (mappings: unknown) => sut.hideDiscardReissueDeliveries(mappings);

  it('replacedFromId 가 채워진 신규(재발송) 건은 제거하고 최초 발송 건만 남긴다', () => {
    const mapping: any = {
      orderDeliveries: [
        { id: 1, replacedFromId: null }, // 최초 발송(원본)
        { id: 2, replacedFromId: 1 }, // 폐기 후 신규 발송
      ],
    };

    hide([mapping]);

    expect(mapping.orderDeliveries).toHaveLength(1);
    expect(mapping.orderDeliveries[0].id).toBe(1);
  });

  it('재발송이 연쇄(체인)로 여러 번 일어나도 최초 발송 1건만 남는다', () => {
    const mapping: any = {
      orderDeliveries: [
        { id: 1, replacedFromId: null },
        { id: 2, replacedFromId: 1 },
        { id: 3, replacedFromId: 2 },
      ],
    };

    hide([mapping]);

    expect(mapping.orderDeliveries.map((d: any) => d.id)).toEqual([1]);
  });

  it('폐기후신규발송이 없으면(모두 replacedFromId null) 원본 목록을 그대로 유지한다', () => {
    const mapping: any = {
      orderDeliveries: [
        { id: 10, replacedFromId: null },
        { id: 11, replacedFromId: null },
      ],
    };

    hide([mapping]);

    expect(mapping.orderDeliveries.map((d: any) => d.id)).toEqual([10, 11]);
  });

  it('여러 상품(mapping) 각각에 대해 독립적으로 필터링한다', () => {
    const mappingA: any = {
      orderDeliveries: [
        { id: 1, replacedFromId: null },
        { id: 2, replacedFromId: 1 },
      ],
    };
    const mappingB: any = {
      orderDeliveries: [{ id: 5, replacedFromId: null }],
    };

    hide([mappingA, mappingB]);

    expect(mappingA.orderDeliveries.map((d: any) => d.id)).toEqual([1]);
    expect(mappingB.orderDeliveries.map((d: any) => d.id)).toEqual([5]);
  });

  it('orderDeliveries 가 없거나 mappings 가 undefined 여도 예외 없이 처리한다', () => {
    const mapping: any = { orderDeliveries: undefined };
    expect(() => hide([mapping])).not.toThrow();
    expect(() => hide(undefined)).not.toThrow();
  });
});
