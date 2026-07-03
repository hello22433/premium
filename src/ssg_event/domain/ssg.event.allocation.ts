export type AllocatableEvent = {
  id: number;
  startAt: Date;
  endAt: Date;
  eventBalance: number;
};

export type AllocatableDelivery = {
  deliveryId: number;
  price: number;
  /** 이 배송건의 예약시각. 없으면 defaultReserveDate → 현재 시각 순으로 폴백(즉시발송). */
  reserveDate?: Date;
};

export type EventAllocation = { deliveryId: number; eventId: number; price: number };

/**
 * 완전 탐색이 한도(budget) 내에 끝나지 않아 할당 가능/불가능을 결정하지 못한 상태.
 * "잔액 부족(null)"과 명확히 구분하기 위한 예외 — 정상적인 입력 규모에서는 발생하지 않는다.
 */
export class SsgAllocationIndeterminateError extends Error {
  constructor(message = 'SSG 행사 자동 할당 탐색을 한도 내에 완료하지 못했습니다.') {
    super(message);
    this.name = 'SsgAllocationIndeterminateError';
  }
}

// 백트래킹 탐색 노드 상한. memoization + 대칭 제거 + 사전검사로 정상 입력은 이 한도에 도달하지 않는다.
const SEARCH_NODE_BUDGET = 2_000_000;

/**
 * 배송건별로 행사를 할당한다.
 * - 각 배송건(상품권)은 하나의 행사에서 전액 처리되어야 한다(분할 불가).
 * - 각 배송건은 자신의 예약시각(reserveDate) 기준으로 유효한(startAt~endAt) 행사에만 매칭한다.
 *   상품별 예약시각이 다르면 배송건마다 후보 행사 집합이 달라진다.
 * - 모든 배송건을 할당 가능할 때만 결과를 반환.
 *
 * 반환/예외:
 * - 성공: EventAllocation[]
 * - 잔액 부족(할당 불가능이 확정됨): null
 * - 탐색 한도 초과로 결정 불가: SsgAllocationIndeterminateError (null과 구분)
 *
 * 후보 집합이 배송건마다 다르므로 단순 first-fit은 실행 가능한 조합을 놓칠 수 있다. 따라서:
 *   1) 사전검사: 후보 없는 배송건 / 전역 수요-잔액 초과를 즉시 판정
 *   2) 빠른 경로: 입력 순서 first-fit(기존 우선순위 보존 + 대량 주문 성능)
 *   3) 정확 탐색: 제약이 강한 배송건부터 백트래킹.
 *      - 실패 상태 memoization(대칭 정규화 키)으로 재방문 차단
 *      - 동일 클래스(후보 소속이 완전히 같은) 행사 간 대칭 제거로 조합 폭발 억제
 */
export const allocateSsgEventsForDeliveries = (
  events: AllocatableEvent[],
  deliveries: AllocatableDelivery[],
  defaultReserveDate?: Date,
): EventAllocation[] | null => {
  if (deliveries.length === 0) {
    return [];
  }

  // 사용 가능한 행사(잔액 > 0), id 오름차순(먼저 등록한 행사 우선)
  const usableEvents = events.filter((event) => event.eventBalance > 0).sort((a, b) => a.id - b.id);
  if (usableEvents.length === 0) {
    return null;
  }

  // 배송건별 후보 행사 인덱스(usableEvents 기준, id 오름차순) 구성
  const candidateIdxByDelivery = deliveries.map((delivery) => {
    const referenceTime = (delivery.reserveDate ?? defaultReserveDate ?? new Date()).getTime();
    const indices: number[] = [];
    for (let i = 0; i < usableEvents.length; i++) {
      const event = usableEvents[i];
      if (event.startAt.getTime() <= referenceTime && event.endAt.getTime() >= referenceTime) {
        indices.push(i);
      }
    }
    return indices;
  });

  // 사전검사 1: 후보가 아예 없는 배송건이 하나라도 있으면 확정 불가
  if (candidateIdxByDelivery.some((indices) => indices.length === 0)) {
    return null;
  }

  // 사전검사 2: 전역 수요 > 후보 행사 잔액 합계면 확정 불가 (명백한 잔액 부족 즉시 판정)
  const candidateEventIdx = new Set<number>();
  for (const indices of candidateIdxByDelivery) {
    for (const i of indices) {
      candidateEventIdx.add(i);
    }
  }
  const totalDemand = deliveries.reduce((sum, d) => sum + d.price, 0);
  let totalCandidateBalance = 0;
  for (const i of candidateEventIdx) {
    totalCandidateBalance += usableEvents[i].eventBalance;
  }
  if (totalDemand > totalCandidateBalance) {
    return null;
  }

  const initialBalances = usableEvents.map((event) => event.eventBalance);

  // 2) 빠른 경로: 입력 순서 first-fit
  {
    const balances = initialBalances.slice();
    const chosen = new Array<number>(deliveries.length).fill(-1); // deliveryPosition -> eventIndex
    let ok = true;
    for (let p = 0; p < deliveries.length; p++) {
      const price = deliveries[p].price;
      let picked = -1;
      for (const i of candidateIdxByDelivery[p]) {
        if (balances[i] >= price) {
          picked = i;
          break;
        }
      }
      if (picked === -1) {
        ok = false;
        break;
      }
      balances[picked] -= price;
      chosen[p] = picked;
    }
    if (ok) {
      return deliveries.map((delivery, p) => ({
        deliveryId: delivery.deliveryId,
        eventId: usableEvents[chosen[p]].id,
        price: delivery.price,
      }));
    }
  }

  // 3) 정확 탐색 준비 —————————————————————————————————————————————

  // 행사 대칭 클래스: 후보 소속 패턴(어떤 배송건이 이 행사를 쓸 수 있는가)이 완전히 같은 행사는 상호 교환 가능
  const candidateSetByDelivery = candidateIdxByDelivery.map((indices) => new Set(indices));
  const classIdBySignature = new Map<string, number>();
  const classIdByEvent = new Array<number>(usableEvents.length).fill(0);
  for (let i = 0; i < usableEvents.length; i++) {
    let signature = '';
    for (let p = 0; p < deliveries.length; p++) {
      signature += candidateSetByDelivery[p].has(i) ? '1' : '0';
    }
    let classId = classIdBySignature.get(signature);
    if (classId === undefined) {
      classId = classIdBySignature.size;
      classIdBySignature.set(signature, classId);
    }
    classIdByEvent[i] = classId;
  }
  const classCount = classIdBySignature.size;

  // 제약이 강한 배송건 우선(후보 수 오름차순, 가격 내림차순)으로 탐색
  const searchOrder = deliveries
    .map((_, p) => p)
    .sort(
      (a, b) =>
        candidateIdxByDelivery[a].length - candidateIdxByDelivery[b].length ||
        deliveries[b].price - deliveries[a].price,
    );

  const balances = initialBalances.slice();
  const chosenEventIdx = new Array<number>(deliveries.length).fill(-1);
  const failedStates = new Set<string>();
  let budget = SEARCH_NODE_BUDGET;

  // 남은 잔액 상태를 대칭 정규화하여 memo 키 생성: 같은 클래스 행사들의 잔액은 정렬해 순서 무시
  const canonicalKey = (stepIndex: number): string => {
    const perClass: number[][] = Array.from({ length: classCount }, () => []);
    for (let i = 0; i < balances.length; i++) {
      perClass[classIdByEvent[i]].push(balances[i]);
    }
    const parts = perClass.map((arr) => arr.sort((x, y) => x - y).join(','));
    return `${stepIndex}|${parts.join(';')}`;
  };

  // 명시적 스택 기반 반복 DFS (배송건 수만큼 재귀하면 call stack 초과 위험 → 반복문으로 전환)
  const stepCount = searchOrder.length;
  const optionList = new Array<number[]>(stepCount); // 각 step에서 시도할 후보 행사 인덱스 목록
  const optionPos = new Array<number>(stepCount).fill(0);
  const memoKeyAtStep = new Array<string>(stepCount);
  const appliedEventIdx = new Array<number>(stepCount).fill(-1); // 각 step에서 적용한 행사 인덱스

  // 현재 step의 후보 목록 구성: 잔액 부족 제외 + 동일 (클래스, 잔액) 대칭 제거
  const buildOptions = (step: number): number[] => {
    const p = searchOrder[step];
    const price = deliveries[p].price;
    const seenSymmetric = new Set<string>();
    const options: number[] = [];
    for (const i of candidateIdxByDelivery[p]) {
      if (balances[i] < price) {
        continue;
      }
      const symKey = `${classIdByEvent[i]}:${balances[i]}`;
      if (seenSymmetric.has(symKey)) {
        continue;
      }
      seenSymmetric.add(symKey);
      options.push(i);
    }
    return options;
  };

  const undoStep = (step: number): void => {
    const p = searchOrder[step];
    balances[appliedEventIdx[step]] += deliveries[p].price;
    chosenEventIdx[p] = -1;
    appliedEventIdx[step] = -1;
  };

  let step = 0;
  let needBuild = true;
  let solved = false;

  while (true) {
    if (step === stepCount) {
      solved = true;
      break;
    }

    if (needBuild) {
      if (--budget <= 0) {
        throw new SsgAllocationIndeterminateError();
      }
      const key = canonicalKey(step);
      if (failedStates.has(key)) {
        // 이미 실패로 판명된 상태 → 되돌아간다
        if (step === 0) {
          break;
        }
        step--;
        undoStep(step);
        needBuild = false;
        continue;
      }
      memoKeyAtStep[step] = key;
      optionList[step] = buildOptions(step);
      optionPos[step] = 0;
      needBuild = false;
    }

    if (optionPos[step] < optionList[step].length) {
      const p = searchOrder[step];
      const eventIdx = optionList[step][optionPos[step]];
      optionPos[step]++;
      balances[eventIdx] -= deliveries[p].price;
      chosenEventIdx[p] = eventIdx;
      appliedEventIdx[step] = eventIdx;
      step++;
      needBuild = true;
      continue;
    }

    // 이 step의 모든 후보 소진 → 실패 상태로 기록하고 백트래킹
    failedStates.add(memoKeyAtStep[step]);
    if (step === 0) {
      break;
    }
    step--;
    undoStep(step);
    needBuild = false;
  }

  if (!solved) {
    return null;
  }

  // 원래 배송건 순서로 결과 반환
  return deliveries.map((delivery, p) => ({
    deliveryId: delivery.deliveryId,
    eventId: usableEvents[chosenEventIdx[p]].id,
    price: delivery.price,
  }));
};
