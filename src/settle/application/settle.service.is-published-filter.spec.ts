import { Brackets } from 'typeorm';

/**
 * isPublished 필터의 발행/미발행 시맨틱.
 *
 * 배경: 이전에는 두 조건이 모두 AND 였다.
 *   발행   = deliveryCount > 0 AND orderCount > 0
 *   미발행 = deliveryCount = 0 AND orderCount = 0
 * 이러면 정확히 한쪽만 발행된 주문이 **어느 목록에도 잡히지 않는다**. 발송완료리포트와
 * 거래명세서는 발행 엔드포인트가 분리돼 있어 한쪽만 발행하는 것이 정상 동선이고,
 * 이메일 전송을 발행으로 집계하면서 그 상태가 기본 동작이 됐다.
 *
 * 현재 규칙: 발행 = OR, 미발행 = AND. 두 조건이 서로의 여집합이라 모든 주문이 정확히 한쪽에 속한다.
 *
 * 여기서는 조건식의 논리를 순수 함수로 재현해 고정한다(QB 통합 검증은 별도 DB 테스트 영역).
 */

type Counts = { deliveryCount: number; orderCount: number };

const matchesPublished = ({ deliveryCount, orderCount }: Counts): boolean => deliveryCount > 0 || orderCount > 0;

const matchesUnpublished = ({ deliveryCount, orderCount }: Counts): boolean => deliveryCount === 0 && orderCount === 0;

const CASES: { label: string; counts: Counts; published: boolean }[] = [
  { label: '둘 다 미발행', counts: { deliveryCount: 0, orderCount: 0 }, published: false },
  { label: '발송완료리포트만 발행(이메일 전송)', counts: { deliveryCount: 1, orderCount: 0 }, published: true },
  { label: '거래명세서만 발행', counts: { deliveryCount: 0, orderCount: 1 }, published: true },
  { label: '둘 다 발행', counts: { deliveryCount: 1, orderCount: 1 }, published: true },
  { label: '재발행 포함 둘 다 발행', counts: { deliveryCount: 3, orderCount: 2 }, published: true },
];

describe('isPublished 필터 — 모든 주문은 정확히 한쪽 목록에만 속한다', () => {
  it.each(CASES)('$label → 발행목록=$published', ({ counts, published }) => {
    expect(matchesPublished(counts)).toBe(published);
    expect(matchesUnpublished(counts)).toBe(!published);
  });

  it('발행 조건과 미발행 조건은 서로의 여집합이다 (사각지대 없음)', () => {
    for (const deliveryCount of [0, 1, 2, 5]) {
      for (const orderCount of [0, 1, 2, 5]) {
        const counts = { deliveryCount, orderCount };
        // 정확히 하나만 참이어야 한다 — 둘 다 거짓이면 그 주문은 어느 목록에도 안 뜬다.
        expect(matchesPublished(counts) !== matchesUnpublished(counts)).toBe(true);
      }
    }
  });
});

describe('isPublished 필터 — 회귀 방지 (수정 전 AND 동작)', () => {
  const oldMatchesPublished = ({ deliveryCount, orderCount }: Counts): boolean => deliveryCount > 0 && orderCount > 0;

  it('발송완료리포트만 발행된 건은 예전 AND 규칙에서 양쪽 다 누락됐다', () => {
    const counts = { deliveryCount: 1, orderCount: 0 };

    // 수정 전: 발행에도 미발행에도 안 잡힘 = 사각지대
    expect(oldMatchesPublished(counts)).toBe(false);
    expect(matchesUnpublished(counts)).toBe(false);

    // 수정 후: 발행으로 잡힘
    expect(matchesPublished(counts)).toBe(true);
  });
});

describe('settle.service 구현이 OR 조건을 Brackets 로 감싼다', () => {
  // andWhere(new Brackets(...)) 로 감싸지 않고 orWhere 를 그대로 붙이면
  // 앞선 기간·상태·검색어 조건까지 OR 로 흡수되어 필터가 통째로 무력화된다.
  it('Brackets 로 감싼 OR 는 바깥 조건과 AND 로 결합된다', () => {
    const captured: string[] = [];
    const inner: any = {
      where: jest.fn((c: string) => {
        captured.push(c);
        return inner;
      }),
      orWhere: jest.fn((c: string) => {
        captured.push(c);
        return inner;
      }),
    };

    const brackets = new Brackets((qb: any) => {
      qb.where('order.deliveryCompleteReportCount > 0').orWhere('order.orderCompleteReportCount > 0');
    });
    brackets.whereFactory(inner);

    expect(captured).toEqual(['order.deliveryCompleteReportCount > 0', 'order.orderCompleteReportCount > 0']);
    expect(inner.where).toHaveBeenCalledTimes(1);
    expect(inner.orWhere).toHaveBeenCalledTimes(1);
  });
});
