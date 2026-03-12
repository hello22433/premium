# 주문접수 - 확인사항 메모 + 수정 기능

## 개요

1. 주문접수 상세에 **확인사항** 메모 섹션 추가 (운영관리자 이상만 작성 가능)
2. 접수(RECEIVED) 상태에서 등록자(고객사)가 제목/첨부파일 수정 가능

---

## 백엔드 변경사항

### 새 API

| Method | URL | 설명 | 권한 |
|--------|-----|------|------|
| `PUT` | `/order-receipt/:id` | 주문접수 수정 (제목, 파일) | 등록자 본인 + RECEIVED 상태만 |
| `PUT` | `/order-receipt/:id/memo` | 확인사항 메모 수정 | 운영관리자(SUPER_ADMIN, OPERATION_ADMIN) 이상 |

### 수정 API 요청 Body

```typescript
// PUT /order-receipt/:id
{
  title: string       // 제목
  filePath: string[]  // 첨부파일 URL 배열
}

// PUT /order-receipt/:id/memo
{
  memo: string        // 확인사항 메모 내용
}
```

### 상세 조회 응답 변경

`GET /order-receipt/:id` 응답에 `memo` 필드 추가:

```typescript
{
  id: number
  userId: number
  userName: string
  title: string
  status: 'RECEIVED' | 'APPROVED' | 'REJECTED'
  filePathList: string[]
  rejectReason: string | null
  memo: string | null           // ← 추가됨
  registerAt: string
  processedAt: string | null
  processedUserName: string | null
}
```

---

## 프론트엔드 작업 내용

### 1. 타입 수정

**`src/apis/order-receipt/type.ts`**:

- `TOrderReceiptDetail`에 `memo: string | null` 추가
- 새 타입 추가:

```typescript
export type TPutOrderReceiptUpdateRequest = {
  title: string
  filePath: string[]
}

export type TPutOrderReceiptMemoRequest = {
  memo: string
}
```

### 2. API 함수 추가

**`src/apis/order-receipt/putOrderReceipt.ts`** (신규):

```typescript
import { API } from '@/constants'
import { Methods, request } from '@/utils'
import type { TPutOrderReceiptUpdateRequest } from './type'

export const putOrderReceipt = async (id: number, data: TPutOrderReceiptUpdateRequest) => {
  return request({
    url: `${API.PROXY.EPOPKON_API}/order-receipt/${id}`,
    method: Methods.PUT,
    data,
  })
}
```

**`src/apis/order-receipt/putOrderReceiptMemo.ts`** (신규):

```typescript
import { API } from '@/constants'
import { Methods, request } from '@/utils'
import type { TPutOrderReceiptMemoRequest } from './type'

export const putOrderReceiptMemo = async (id: number, data: TPutOrderReceiptMemoRequest) => {
  return request({
    url: `${API.PROXY.EPOPKON_API}/order-receipt/${id}/memo`,
    method: Methods.PUT,
    data,
  })
}
```

### 3. Query Hook 추가

**`src/queries/order-receipt/index.ts`**에 mutation 추가:

- `useUpdateOrderReceiptMutation` — 주문접수 수정 (invalidate: ORDER_RECEIPT_LIST, ORDER_RECEIPT)
- `useUpdateOrderReceiptMemoMutation` — 메모 수정 (invalidate: ORDER_RECEIPT)

### 4. 주문접수 상세 화면 수정

**`src/features/order/receipt/OrderReceiptDetailPage.tsx`**:

#### 4-1. 확인사항 섹션 추가

첨부파일 섹션 아래(반려사유 위)에 "확인사항" 섹션 추가:

- **운영관리자(SUPER_ADMIN, OPERATION_ADMIN)**: textarea로 표시, 저장 버튼 포함
- **고객사(CORPORATE_ADMIN)**: 메모가 있으면 읽기 전용으로 표시, 없으면 숨김
- 모든 상태(RECEIVED/APPROVED/REJECTED)에서 운영관리자가 작성/수정 가능

```tsx
{/* 확인사항 - 운영관리자: 편집 가능, 고객사: 읽기 전용 */}
{(isAdmin || data?.memo) && (
  <div className="mb-3">
    <label className="form-label text-lg">확인사항</label>
    {isAdmin ? (
      <>
        <textarea
          className="form-control"
          rows={3}
          placeholder="확인사항을 입력해주세요"
          value={memo}
          onChange={e => setMemo(e.target.value)}
        />
        <div className="mt-2">
          <button className="btn btn-sm btn-outline-primary" onClick={handleSaveMemo}>
            확인사항 저장
          </button>
        </div>
      </>
    ) : (
      <textarea className="form-control" rows={3} disabled value={data?.memo || ''} />
    )}
  </div>
)}
```

#### 4-2. 접수 상태에서 수정 기능

RECEIVED 상태 + 등록자 본인일 때:

- 제목 필드를 **편집 가능**하게 변경 (disabled 제거)
- 파일 첨부/삭제 UI 활성화
- **수정** 버튼 추가 (handleUpdate)

```tsx
// 수정 가능 여부 판단
const canEdit = data?.status === 'RECEIVED' && data?.userId === currentUserId
```

**주의**: 현재 `useUserInfo`에 `userId`가 없으므로, 쿠키에서 userId를 가져오거나 별도로 확인 필요. 또는 백엔드 응답의 `userId`와 비교.

#### 4-3. 권한별 UI 정리

| 상태 | 고객사(등록자) | 운영관리자 |
|------|--------------|-----------|
| RECEIVED | 제목/파일 수정, 삭제 | 승인, 반려, 확인사항 작성, 삭제 |
| APPROVED | 조회만 | 확인사항 수정 |
| REJECTED | 삭제 | 확인사항 수정, 삭제 |

---

## DB 마이그레이션

```sql
ALTER TABLE order_receipt ADD COLUMN memo TEXT NULL COMMENT '확인사항 메모 (운영관리자 기재)' AFTER reject_reason;
```
