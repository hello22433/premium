# 담당 3 — 2026-06-19 작업 인덱스 (D3-36 PII_BEARING_HISTORY_TYPES 수동 동기화 위험)

본 인덱스는 잔여 위험 **D3-36**(PII_BEARING_HISTORY_TYPES 수동 동기화 위험, D3-21 파생)을 요약한다.  
상세 본문: `findings-담당3-2026-06-19-D3-36-PII_BEARING_HISTORY_TYPES-수동동기화.md`  
부모 항목: D3-21 (`findings-담당3-2026-06-18-D3-21-조기파기-executeRequest-order_history-type무시-상태이력파괴.md`)

> **요지**: `CS_HISTORY_TYPES`(6개, DTO 허용값)와 `PII_BEARING_HISTORY_TYPES`(2개, 마스킹 필터)가 별개 파일에서 독립 관리됨. 새 CS type 추가 시 PII 분류 여부 결정을 강제할 장치가 없었음. **파티션 테스트(`CS_HISTORY_TYPES = PII ∪ 비PII`)를 추가해 강제화. 수정완료.**

---

## A. 수정 내용

| 항목 | 수정 전 | 수정 후 | 상태 |
|---|---|---|---|
| PII 분류 강제 | 주석 의존 (컴파일·테스트 미강제) | 파티션 테스트 — PII ∪ 비PII = CS_HISTORY_TYPES assertion | ✅ |
| 부분집합 검증 | 없음 | `PII_BEARING ⊆ CS_HISTORY_TYPES` 테스트 | ✅ |

---

## B. 수정 커밋

| 커밋 | 날짜 | 내용 |
|---|---|---|
| (커밋 예정) | 06-19 | D3-36 파티션 테스트 추가 (`customer.service.history-type.dto.spec.ts`) |

---

## C. 테스트 추가 위치

| 파일 | 추가 내용 |
|---|---|
| `src/customer_service/api/customer.service.history-type.dto.spec.ts` | `CS_HISTORY_TYPES ↔ PII_BEARING_HISTORY_TYPES 파티션 (D3-36)` describe 블록 (2케이스) |

**새 type 추가 시 체크리스트** (테스트 실패로 강제):
1. `CS_HISTORY_TYPES`에 추가 → 스냅샷 테스트 실패
2. 스냅샷 업데이트
3. PII 보유 여부 결정 → `PII_BEARING_HISTORY_TYPES` 또는 `CONFIRMED_NON_PII_TYPES` 중 하나에 추가
4. 파티션 테스트 통과

---

## D. 참고 문서

- `findings-담당3-2026-06-19-D3-36-PII_BEARING_HISTORY_TYPES-수동동기화.md` — 본문
- `findings-담당3-2026-06-18-D3-21-조기파기-executeRequest-order_history-type무시-상태이력파괴.md` — 부모 D3-21
- `src/order/interface/order.history.pii.types.ts` — `PII_BEARING_HISTORY_TYPES` 단일 소스
- `src/customer_service/api/customer.service.req.dto.ts:251-258` — `CS_HISTORY_TYPES` 정의
- `src/customer_service/api/customer.service.history-type.dto.spec.ts` — 파티션 테스트 추가 위치
