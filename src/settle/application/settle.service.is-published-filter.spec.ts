import { Brackets } from 'typeorm';
import { applyIsPublishedFilter } from './settle.is-published.filter';

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
 * ⚠️ 이 스펙은 프로덕션 함수 applyIsPublishedFilter 를 **실제로 실행**한다. 조건식을 테스트
 * 파일 안에서 재구현하면 프로덕션을 AND 로 되돌려도 전부 통과하는 자기충족 테스트가 된다.
 * QueryBuilder 를 기록형 스텁으로 대체하고, Brackets 의 whereFactory 까지 실행해 실제로
 * 생성되는 조건 트리를 관찰한다.
 */

type Captured = { kind: 'andWhere' | 'where' | 'orWhere'; condition: string };

/** andWhere(Brackets) 를 만나면 그 안까지 펼쳐 기록하는 QueryBuilder 스텁 */
const makeQbStub = () => {
  const calls: Captured[] = [];
  const qb: any = {
    andWhere: jest.fn((arg: unknown) => {
      if (arg instanceof Brackets) {
        // andWhere 도 받아 둔다 — OR 를 AND 로 되돌리는 회귀가 크래시가 아니라
        // 단언 실패로 잡히게 하기 위해서다(실패 원인이 메시지에 그대로 드러난다).
        const inner: any = {
          where: jest.fn((c: string) => {
            calls.push({ kind: 'where', condition: c });
            return inner;
          }),
          orWhere: jest.fn((c: string) => {
            calls.push({ kind: 'orWhere', condition: c });
            return inner;
          }),
          andWhere: jest.fn((c: string) => {
            calls.push({ kind: 'andWhere', condition: c });
            return inner;
          }),
        };
        // Brackets 로 감싼 경계를 표시해 둔다 — 감싸지 않으면 이 마커가 없다.
        calls.push({ kind: 'andWhere', condition: '(' });
        arg.whereFactory(inner);
        calls.push({ kind: 'andWhere', condition: ')' });
      } else {
        calls.push({ kind: 'andWhere', condition: String(arg) });
      }
      return qb;
    }),
  };
  return { qb, calls };
};

const run = (isPublished?: boolean) => {
  const { qb, calls } = makeQbStub();
  const returned = applyIsPublishedFilter(qb, isPublished);
  return { calls, returned, qb };
};

const DC = 'order.deliveryCompleteReportCount';
const OC = 'order.orderCompleteReportCount';

describe('applyIsPublishedFilter — 발행(OR)', () => {
  it('두 카운트를 OR 로 묶는다 (AND 였다면 한쪽만 발행된 주문이 누락된다)', () => {
    const { calls } = run(true);

    expect(calls.filter((c) => c.kind === 'where' || c.kind === 'orWhere')).toEqual([
      { kind: 'where', condition: `${DC} > 0` },
      { kind: 'orWhere', condition: `${OC} > 0` },
    ]);
  });

  it('OR 를 Brackets 로 감싼다 (앞선 기간·상태 조건이 OR 로 흡수되는 것 방지)', () => {
    const { calls } = run(true);

    // 괄호 마커 사이에 OR 조건이 들어 있어야 한다.
    const open = calls.findIndex((c) => c.condition === '(');
    const close = calls.findIndex((c) => c.condition === ')');
    expect(open).toBeGreaterThanOrEqual(0);
    expect(close).toBeGreaterThan(open);
    expect(calls.slice(open + 1, close).map((c) => c.kind)).toEqual(['where', 'orWhere']);
  });

  it('발행 조건에서는 = 0 비교를 쓰지 않는다', () => {
    const { calls } = run(true);

    expect(calls.some((c) => c.condition.includes('= 0'))).toBe(false);
  });
});

describe('applyIsPublishedFilter — 미발행(AND)', () => {
  it('두 카운트가 모두 0 인 조건을 AND 로 건다', () => {
    const { calls } = run(false);

    expect(calls).toEqual([
      { kind: 'andWhere', condition: `${DC} = 0` },
      { kind: 'andWhere', condition: `${OC} = 0` },
    ]);
  });

  it('미발행 조건은 Brackets 로 감싸지 않는다 (AND 라 감쌀 필요가 없다)', () => {
    const { calls } = run(false);

    expect(calls.some((c) => c.condition === '(')).toBe(false);
  });
});

describe('applyIsPublishedFilter — 필터 미지정', () => {
  it('isPublished 가 undefined 면 아무 조건도 걸지 않는다', () => {
    const { calls, qb } = run(undefined);

    expect(calls).toEqual([]);
    expect(qb.andWhere).not.toHaveBeenCalled();
  });

  it('QueryBuilder 를 그대로 반환해 체이닝을 유지한다', () => {
    const { returned, qb } = run(undefined);

    expect(returned).toBe(qb);
  });
});

describe('발행/미발행이 서로의 여집합인가 (사각지대 0)', () => {
  // 생성된 SQL 조건을 실제 카운트 조합에 적용해 평가한다.
  const evaluate = (calls: Captured[], dc: number, oc: number): boolean => {
    const value = (cond: string) => (cond.startsWith(DC) ? dc : oc);
    const test = (cond: string) => (cond.includes('> 0') ? value(cond) > 0 : value(cond) === 0);

    const inBrackets = calls.filter((c) => c.kind === 'where' || c.kind === 'orWhere');
    if (inBrackets.length) return inBrackets.some((c) => test(c.condition));
    return calls.filter((c) => c.condition !== '(' && c.condition !== ')').every((c) => test(c.condition));
  };

  const published = run(true).calls;
  const unpublished = run(false).calls;

  it.each([
    ['둘 다 미발행', 0, 0, false],
    ['발송완료리포트만 발행(이메일 전송)', 1, 0, true],
    ['거래명세서만 발행', 0, 1, true],
    ['둘 다 발행', 1, 1, true],
    ['재발행 포함', 3, 2, true],
  ])('%s → 발행목록=%s', (_label, dc, oc, expected) => {
    expect(evaluate(published, dc as number, oc as number)).toBe(expected);
    expect(evaluate(unpublished, dc as number, oc as number)).toBe(!expected);
  });

  it('4x4 전 조합에서 정확히 한쪽에만 속한다', () => {
    for (const dc of [0, 1, 2, 5]) {
      for (const oc of [0, 1, 2, 5]) {
        expect(evaluate(published, dc, oc)).not.toBe(evaluate(unpublished, dc, oc));
      }
    }
  });
});
