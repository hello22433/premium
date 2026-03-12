# 고객사 정산 API 분리 - 프론트엔드 작업 안내

## 변경 배경

기존 `/settle/user/list` API가 페이지 이동마다 **전체 검색 결과의 합계(totalAmountSum, totalDeliveryPriceSum, totalSettlePriceSum)**를 매번 재계산하여 6~15초의 응답 지연이 발생했습니다.

합계 계산을 별도 API로 분리하여, **페이지 이동 시에는 목록만 빠르게 조회**하고 **필터 변경 시에만 합계를 재계산**하도록 변경합니다.

## API 변경 사항

### 1. `GET /settle/user/list` (수정)

**제거된 응답 필드:**
- `totalAmountSum`
- `totalDeliveryPriceSum`
- `totalSettlePriceSum`

**유지되는 응답 필드:**
```json
{
  "list": [...],
  "totalPage": 59,
  "totalCount": 585,
  "currentPage": 3
}
```

### 2. `GET /settle/user/summary` (신규)

**요청 파라미터:** 기존 목록 API와 동일한 검색 조건 (page/take 제외)
- `startAt`, `endAt`, `isPublished`, `businessName`, `personName`, `eventName`, `searchKeyword`

**응답:**
```json
{
  "totalCount": 585,
  "totalAmountSum": 29633,
  "totalDeliveryPriceSum": 712544600,
  "totalSettlePriceSum": 711539088
}
```

## 프론트엔드 수정 포인트

### 1. API 호출 분리

```typescript
// 기존: 페이지 이동마다 목록 + 합계 동시 조회
const { list, totalAmountSum, totalDeliveryPriceSum, totalSettlePriceSum, ...pagination } = await getSettleUserList(params);

// 변경: 목록과 합계를 별도로 관리
const { list, ...pagination } = await getSettleUserList(params);
const { totalAmountSum, totalDeliveryPriceSum, totalSettlePriceSum } = await getSettleUserSummary(filterParams);
```

### 2. 합계 조회 시점

- **필터 변경 시** (날짜, 발행여부, 검색어 등): 목록 + 합계 모두 재조회
- **페이지 이동 시**: 목록만 재조회, 합계는 기존 값 유지

### 3. 수정 대상 파일 (참고)

- `getSettleUser.ts` — API 함수에 `getSettleUserSummary()` 추가
- `index.tsx` (정산관리 > 고객사 정산 페이지) — 합계 상태를 별도 관리, 페이지 이동 시 합계 API 호출 제거
- `BatchStatementModal.tsx` — 이 모달은 목록만 필요하므로 합계 API 호출 불필요
