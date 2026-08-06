// ★ requireActual 스프레드 필수: import 그래프 내 다른 서비스가 Propagation 등 다른 export 를
//   클래스정의 시점에 쓰므로, 전체 모듈을 덮으면 로드가 깨진다.
jest.mock('typeorm-transactional', () => ({
  ...jest.requireActual('typeorm-transactional'),
  Transactional: () => () => undefined,
  runOnTransactionCommit: (cb: () => void) => cb(),
}));

import { BadRequestException } from '@nestjs/common';
import { OrderService } from './order.service';

/**
 * deliveryCancel 의 주문 행 잠금 계약.
 *
 * 기존 취소 스펙 4종은 createQueryBuilder 가 락 쿼리와 그래프 쿼리에 **같은 builder** 를
 * 돌려주도록 mock 해서, setLock 스텁만 있고 호출 여부를 기록하지 않는다. 그래서
 * `.setLock('pessimistic_write')` 한 줄을 지워도 전부 통과한다 — 락을 지키는 테스트가 없었다.
 * 여기서는 쿼리마다 별개 builder 를 돌려주어 두 쿼리를 구분하고, 아래를 고정한다.
 *
 *  1) 첫 쿼리가 pessimistic_write 로 잠근다
 *  2) 잠금 쿼리와 그래프 쿼리가 분리돼 있다
 *     — 조인을 건 채로 FOR UPDATE 를 걸면 product 행까지 잠겨 같은 상품을 쓰는 무관한
 *       주문들이 직렬화된다. 주석이 명시적으로 경계한 실패 모드다.
 *  3) 락 대상이 없으면(주문 부재) 그래프 조회로 진행하지 않고 거부한다
 */
describe('OrderService.deliveryCancel — 주문 행 잠금', () => {
  const setup = (lockedOrder: unknown) => {
    const builders: { locked: boolean; joins: string[]; lockMode?: string }[] = [];

    const createQueryBuilder = jest.fn(() => {
      const rec: { locked: boolean; joins: string[]; lockMode?: string } = { locked: false, joins: [] };
      builders.push(rec);
      const builder: any = {
        setLock: (mode: string) => {
          rec.locked = true;
          rec.lockMode = mode;
          return builder;
        },
        leftJoinAndSelect: (relation: string) => {
          rec.joins.push(relation);
          return builder;
        },
        where: () => builder,
        andWhere: () => builder,
        // 첫 쿼리(잠금)만 결과를 주고, 그 뒤 그래프 조회는 여기까지 도달했는지 확인용으로 중단시킨다.
        getOne: async () => (builders.length === 1 ? lockedOrder : Promise.reject(new Error('__GRAPH_QUERY__'))),
      };
      return builder;
    });

    const sut: any = Object.create(OrderService.prototype);
    // 소유권(조회범위) 검증은 order.service.cancel-ownership.spec 에서 다룬다 — 여기선 통과시킨다.
    sut.assertOrderInViewScope = jest.fn().mockResolvedValue(undefined);
    sut.orderRepository = { createQueryBuilder };
    return { sut, builders, createQueryBuilder };
  };

  const body = { id: 1001, cancelReason: '고객 요청' };

  it('첫 쿼리가 주문 행을 pessimistic_write 로 잠근다', async () => {
    const { sut, builders } = setup({ id: 1001 });

    await expect(sut.deliveryCancel({ id: 1 }, body)).rejects.toThrow('__GRAPH_QUERY__');

    expect(builders[0].locked).toBe(true);
    expect(builders[0].lockMode).toBe('pessimistic_write');
  });

  it('잠금 쿼리에는 조인을 걸지 않는다 (조인 채로 FOR UPDATE 하면 product 행까지 잠긴다)', async () => {
    const { sut, builders } = setup({ id: 1001 });

    await expect(sut.deliveryCancel({ id: 1 }, body)).rejects.toThrow('__GRAPH_QUERY__');

    expect(builders[0].joins).toEqual([]);
  });

  it('그래프 조회는 잠금과 분리된 별도 쿼리이며 잠그지 않는다', async () => {
    const { sut, builders } = setup({ id: 1001 });

    await expect(sut.deliveryCancel({ id: 1 }, body)).rejects.toThrow('__GRAPH_QUERY__');

    expect(builders).toHaveLength(2);
    expect(builders[1].locked).toBe(false);
    expect(builders[1].joins.length).toBeGreaterThan(0);
  });

  it('잠글 주문이 없으면 그래프 조회로 진행하지 않고 거부한다', async () => {
    const { sut, createQueryBuilder } = setup(null);

    await expect(sut.deliveryCancel({ id: 1 }, body)).rejects.toBeInstanceOf(BadRequestException);
    expect(createQueryBuilder).toHaveBeenCalledTimes(1);
  });
});
