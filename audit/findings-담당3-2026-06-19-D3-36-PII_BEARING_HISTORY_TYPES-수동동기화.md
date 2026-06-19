# 담당 3 — D3-36 PII_BEARING_HISTORY_TYPES 수동 동기화 위험 (2026-06-19)

> **상태**: ✅ **수정완료** — 파티션 테스트 추가로 강제화  
> **등급**: L (개발 프로세스 위험, 잔액 무관)  
> **부모**: D3-21 (`PII_BEARING_HISTORY_TYPES` 단일 소스 추출 후 잔여 위험)  
> **수정 커밋**: (하단 참조)

---

## §1. 발견 경위

D3-21 수정(`f21ec30`) 시 `PII_BEARING_HISTORY_TYPES` 상수를 `order.history.pii.types.ts`로 추출했다.  
이 상수는 `CS_HISTORY_TYPES`(6개)의 부분집합(2개)이나 두 상수가 **별개 파일에서 독립 관리**된다.

---

## §2. 구조 분석

### 2-1. 두 상수의 관계

```ts
// src/customer_service/api/customer.service.req.dto.ts:251-258
export const CS_HISTORY_TYPES = [
  '단순문의',
  '재전송',
  '수신정보 변경요청',   // ← PII 보유
  '폐기',
  '환불폐기',
  '폐기 후 신규 발송',  // ← PII 보유
] as const;

// src/order/interface/order.history.pii.types.ts:14
export const PII_BEARING_HISTORY_TYPES = ['수신정보 변경요청', '폐기 후 신규 발송'] as const;
//                                        ↑ CS_HISTORY_TYPES 의 부분집합
```

두 파일에 cross-reference 주석이 있으나 **컴파일 타임 / 테스트 타임 강제는 없음**.

### 2-2. 기존 스냅샷 테스트의 한계

```ts
// customer.service.history-type.dto.spec.ts:45-54
it('CS_HISTORY_TYPES 는 6개 유효 유형으로 고정된다', () => {
  expect([...CS_HISTORY_TYPES]).toEqual([...]);  // ← 추가 시 실패
});
```

새 type 추가 시 스냅샷 테스트가 **실패하여 개발자를 인지시키나**, 스냅샷을 업데이트할 때 `PII_BEARING_HISTORY_TYPES` 동기화 여부는 **강제하지 않는다**.

### 2-3. 위험 시나리오

1. 개발자가 CS에 `'주소 변경요청'` (수신처 주소 포함 PII 보유) type 추가
2. `CS_HISTORY_TYPES`에 추가 → 스냅샷 테스트 실패
3. 스냅샷 업데이트(6→7개) 후 커밋
4. `PII_BEARING_HISTORY_TYPES` 미업데이트 → 조기/정기파기 마스킹 누락
5. 파기 후 `beforeChange/afterChange`에 주소 잔존

---

## §3. 수정

### 3-1. 파티션 테스트 추가 (핵심)

`CS_HISTORY_TYPES = PII_BEARING_HISTORY_TYPES ∪ CONFIRMED_NON_PII_TYPES` 를 assertion으로 검증.

새 type 추가 시 반드시 두 목록 중 하나에 분류해야 테스트 통과 → 사람 결정을 강제.

```ts
// customer.service.history-type.dto.spec.ts 에 추가

import { PII_BEARING_HISTORY_TYPES } from '../../../order/interface/order.history.pii.types';

describe('CS_HISTORY_TYPES ↔ PII_BEARING_HISTORY_TYPES 파티션 (D3-36)', () => {
  // PII를 담지 않음이 확인된 type 목록 (업데이트 시 PII 여부 재검토 필요)
  const CONFIRMED_NON_PII_TYPES = ['단순문의', '재전송', '폐기', '환불폐기'] as const;

  it('PII_BEARING_HISTORY_TYPES 는 CS_HISTORY_TYPES 의 부분집합이다', () => {
    const csSet = new Set([...CS_HISTORY_TYPES]);
    for (const t of PII_BEARING_HISTORY_TYPES) {
      expect(csSet.has(t)).toBe(true);
    }
  });

  it('CS_HISTORY_TYPES 의 모든 type 이 PII·비PII 중 하나로 분류돼 있다 (D3-36 동기화 가드)', () => {
    const classified = new Set([...PII_BEARING_HISTORY_TYPES, ...CONFIRMED_NON_PII_TYPES]);
    expect(classified).toEqual(new Set([...CS_HISTORY_TYPES]));
  });
});
```

### 3-2. 효과

| 시나리오 | 기존 (스냅샷만) | 수정 후 (파티션 추가) |
|---|---|---|
| 새 type 추가, PII 분류 누락 | 스냅샷 실패 → 개발자가 스냅샷만 업데이트 가능 | 파티션 테스트도 실패 → 반드시 PII/비PII 분류해야 통과 |
| 기존 PII type 이름 변경 | 스냅샷 실패 + PII_BEARING 주석 의존 | 부분집합 테스트 실패 → 양쪽 업데이트 강제 |

---

## §4. 연관

- `findings-담당3-2026-06-19-D3-36-PII_BEARING_HISTORY_TYPES-수동동기화-index.md` — 인덱스
- `src/order/interface/order.history.pii.types.ts` — PII type 단일 소스
- `src/customer_service/api/customer.service.req.dto.ts:251-258` — CS_HISTORY_TYPES 정의
- `src/customer_service/api/customer.service.history-type.dto.spec.ts` — 파티션 테스트 추가 위치
- `findings-담당3-2026-06-18-D3-21-조기파기-executeRequest-order_history-type무시-상태이력파괴.md` — 부모 (D3-21)
