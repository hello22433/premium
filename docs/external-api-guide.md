# ePOPKON External API 연동 가이드

## 개요

ePOPKON External API는 외부 서비스가 ePOPKON 플랫폼을 통해 모바일 쿠폰(기프티콘)을 주문하고 발송할 수 있도록 제공하는 REST API입니다.

### Base URL
 
```
https://{서버주소}/api/v1/external
```

### 인증

모든 API 요청에 `X-API-Key` 헤더가 필요합니다.

```
X-API-Key: {발급받은 API Key}
```

- API Key는 관리자에게 발급 요청합니다.
- Key는 SHA-256 해시로 서버에 저장되므로, 분실 시 재발급이 필요합니다.
- 계정이 비활성 상태이면 인증이 거부됩니다.

### 응답 형식

성공과 에러의 응답 구조가 다릅니다. **HTTP 상태 코드(200 vs 4xx/5xx)로 먼저 분기**한 후, 각 구조에 맞게 파싱해야 합니다.

**성공 응답 (HTTP 200):**

최상위에 `code`, `message`, `data` 필드가 위치합니다.

```json
{
  "code": "0000",
  "message": "success",
  "data": { ... }
}
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `code` | string | 결과 코드 (성공 시 항상 `"0000"`) |
| `message` | string | 결과 메시지 |
| `data` | object/array | 응답 데이터 (엔드포인트별 상이) |

**에러 응답 (HTTP 4xx/5xx):**

`result` 객체로 감싸져 있습니다. 성공 응답과 **구조가 다르므로** 별도 파싱이 필요합니다.

```json
{
  "result": {
    "code": "에러코드",
    "message": "에러 메시지",
    "detail": "상세 내용 (선택)"
  }
}
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `result.code` | string | 에러 코드 (에러 코드표 참조) |
| `result.message` | string | 에러 메시지 |
| `result.detail` | string? | 상세 내용 (유효성 검증 실패 시 구체적 사유 등) |

**파싱 분기 로직:**

```
HTTP 상태 코드 확인
├─ 200     → 최상위 code / message / data 파싱
└─ 4xx/5xx → result.code / result.message / result.detail 파싱
```

---

## API 목록

| Method | Endpoint | 설명 |
|--------|----------|------|
| GET | `/products` | 상품 목록 조회 |
| POST | `/orders` | 쿠폰 주문 및 즉시 발송 |
| GET | `/orders/:trId/status` | 주문 상태 조회 |
| POST | `/orders/:trId/resend` | 쿠폰 재발송 |
| DELETE | `/orders/:trId` | 주문 취소 (환불) |
| POST | `/orders/ssg` | SSG 쿠폰 주문 및 발송 |
| GET | `/orders/ssg/:trId/status` | SSG 주문 상태 조회 |

---

## 1. 상품 목록 조회

계정에 할당된 상품 목록을 조회합니다. 관리자가 해당 계정에 등록한 상품만 조회할 수 있으며, 특정 상품 코드를 지정하여 필터링할 수 있습니다.

### Request

```
GET /api/v1/external/products
GET /api/v1/external/products?productCode=PRD001
```

```bash
curl -X GET "https://{서버주소}/api/v1/external/products" \
  -H "X-API-Key: {API_KEY}"
```

### Query Parameters

| 파라미터 | 타입 | 필수 | 설명 |
|----------|------|------|------|
| `productCode` | string | X | 특정 상품 코드로 필터링 |

### Response

```json
{
  "code": "0000",
  "message": "success",
  "data": [
    {
      "productCode": "PRD001",
      "productName": "스타벅스 아메리카노 T",
      "brandName": "스타벅스",
      "price": 4500,
      "salePrice": 4500,
      "imageUrl": "/uploads/products/starbucks-americano.jpg",
      "validDays": 93
    }
  ]
}
```

### Response Fields

| 필드 | 타입 | 설명 |
|------|------|------|
| `productCode` | string | 상품 코드 (주문 시 사용) |
| `productName` | string | 상품명 |
| `brandName` | string | 브랜드명 |
| `price` | number | 정가 (원) |
| `salePrice` | number | 판매가 (원) |
| `imageUrl` | string | 상품 이미지 경로 |
| `validDays` | number | 쿠폰 유효기간 (일) |

### 주의사항

- 계정에 할당되지 않은 상품은 조회할 수 없습니다.
- 할당되지 않은 상품 코드로 필터링 시 에러 코드 `3001`이 반환됩니다.
- 할당된 상품이 없는 경우 빈 배열 `[]`이 반환됩니다.

---

## 2. 쿠폰 주문 및 즉시 발송

상품을 주문하고 수신자에게 쿠폰을 즉시 발송합니다.

주문 처리는 3단계로 진행됩니다:
1. **Phase A**: 주문 생성 + 잔액 차감 (DB 트랜잭션)
2. **Phase B**: 쿠폰 발행 + 메시지 발송 (외부 HTTP)
3. **Phase C**: 성공 상태 업데이트 (DB 트랜잭션)

Phase B 실패 시 잔액은 자동 환불됩니다.

### Request

```
POST /api/v1/external/orders
```

```bash
curl -X POST "https://{서버주소}/api/v1/external/orders" \
  -H "X-API-Key: {API_KEY}" \
  -H "Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000" \
  -H "Content-Type: application/json" \
  -d '{
    "productCode": "PRD001",
    "recipientPhone": "01012345678",
    "senderPhone": "01098765432",
    "title": "선물을 보냈습니다",
    "message": "생일 축하합니다!",
    "deliveryMethod": "ALIM_TALK"
  }'
```

### Headers

| 헤더 | 필수 | 설명 |
|------|------|------|
| `X-API-Key` | O | API 인증 키 |
| `Idempotency-Key` | O | 중복 요청 방지 키 (최대 64자, UUID v4 권장) |

**`Idempotency-Key` 동작:**
- 동일한 키로 재요청 시, 새 주문을 생성하지 않고 기존 주문 결과를 반환합니다.
- 네트워크 오류로 응답을 받지 못한 경우, 같은 키로 안전하게 재시도할 수 있습니다.
- 중복 판단 기준: `Idempotency-Key` + `X-API-Key` + API 엔드포인트
- 같은 키로 **다른 요청 바디**를 보내면 에러 코드 `2004` (422)가 반환됩니다.
- 이전 요청이 아직 **처리 중**일 때 같은 키로 재요청하면 에러 코드 `2005` (409)가 반환됩니다.

### Body Parameters

| 파라미터 | 타입 | 필수 | 설명 |
|----------|------|------|------|
| `productCode` | string | O | 상품 코드 (`/products`에서 조회) |
| `recipientPhone` | string | O | 수신자 전화번호 (예: `01012345678`) |
| `senderPhone` | string | O | 발신자 전화번호 |
| `title` | string | X | 메시지 제목 (미입력 시 상품명 사용) |
| `message` | string | X | 메시지 내용 |
| `deliveryMethod` | string | O | 발송 방법: `ALIM_TALK`, `MMS`, `EMAIL` |

**`deliveryMethod` 설명:**

| 값 | 설명 |
|----|------|
| `ALIM_TALK` | 카카오 알림톡으로 발송 |
| `MMS` | MMS 문자로 발송 |
| `EMAIL` | 이메일로 발송 |

### Response

```json
{
  "code": "0000",
  "message": "success",
  "data": {
    "trId": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "barCode": "8801234567890",
    "validStartDate": "2026-03-31",
    "validEndDate": "2026-07-01",
    "price": 4500
  }
}
```

### Response Fields

| 필드 | 타입 | 설명 |
|------|------|------|
| `trId` | string | 시스템 생성 고유 식별자 (ULID 형식, 26자 영숫자) |
| `barCode` | string? | 쿠폰 핀번호 (협력사에 따라 없을 수 있음) |
| `validStartDate` | string? | 쿠폰 유효기간 시작일 (YYYY-MM-DD) |
| `validEndDate` | string? | 쿠폰 유효기간 종료일 (YYYY-MM-DD) |
| `price` | number | 결제 금액 (원) |

---

## 3. 주문 상태 조회

트랜잭션 ID로 주문의 현재 상태를 조회합니다.

### Request

```
GET /api/v1/external/orders/:trId/status
```

```bash
curl -X GET "https://{서버주소}/api/v1/external/orders/01ARZ3NDEKTSV4RRFFQ69G5FAV/status" \
  -H "X-API-Key: {API_KEY}"
```

### Path Parameters

| 파라미터 | 타입 | 필수 | 설명 |
|----------|------|------|------|
| `trId` | string | O | 주문 시 발급받은 트랜잭션 ID |

### Response

```json
{
  "code": "0000",
  "message": "success",
  "data": {
    "trId": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "couponStatus": "NOT_USED",
    "deliveryStatus": "COMPLETE",
    "barCode": "8801234567890",
    "validStartDate": "2026-03-31",
    "validEndDate": "2026-07-01",
    "price": 4500
  }
}
```

### Response Fields

| 필드 | 타입 | 설명 |
|------|------|------|
| `trId` | string | 트랜잭션 ID |
| `couponStatus` | string | 쿠폰 상태 (아래 표 참조) |
| `deliveryStatus` | string | 발송 상태 (아래 표 참조) |
| `barCode` | string? | 쿠폰 핀번호 |
| `validStartDate` | string? | 유효기간 시작일 |
| `validEndDate` | string? | 유효기간 종료일 |
| `price` | number | 결제 금액 |

**쿠폰 상태 (`couponStatus`):**

| 값 | 설명 |
|----|------|
| `NOT_USED` | 미사용 (발행 완료) |
| `USED` | 사용 완료 (교환) |
| `CANCEL` | 취소 (폐기) |
| `REFUND_CANCEL` | 환불 취소 |
| `EXPIRED` | 기간 만료 |

**발송 상태 (`deliveryStatus`):**

| 값 | 설명 |
|----|------|
| `WAIT` | 발송 대기 |
| `COMPLETE` | 발송 완료 |
| `COMPLETE_SMS` | 알림톡 불가로 SMS 전송 성공 |
| `FAIL` | 발송 실패 |
| `FAIL_SMS` | 알림톡 불가 + SMS 전송 실패 |
| `CANCEL` | 취소됨 |

---

## 4. 쿠폰 재발송

이미 발행된 쿠폰을 수신자에게 다시 발송합니다. 쿠폰이 발행된 상태(`barCode`가 존재)에서만 가능합니다.

### Request

```
POST /api/v1/external/orders/:trId/resend
```

```bash
curl -X POST "https://{서버주소}/api/v1/external/orders/01ARZ3NDEKTSV4RRFFQ69G5FAV/resend" \
  -H "X-API-Key: {API_KEY}"
```

### Path Parameters

| 파라미터 | 타입 | 필수 | 설명 |
|----------|------|------|------|
| `trId` | string | O | 트랜잭션 ID |

### Response

```json
{
  "code": "0000",
  "message": "success"
}
```

### 주의사항

- 쿠폰이 발행되지 않은 주문(발송 실패 등)은 재발송할 수 없습니다 (에러 코드 `3004`).
- 재발송 시 추가 비용은 발생하지 않습니다.
- 계정별 재발송 한도(기본 3회)를 초과하면 에러 코드 `3008`이 반환됩니다. 한도는 관리자가 계정 단위로 조정할 수 있습니다.

---

## 5. 주문 취소 (환불)

주문을 취소하고 잔액을 환불합니다.

### Request

```
DELETE /api/v1/external/orders/:trId
```

```bash
curl -X DELETE "https://{서버주소}/api/v1/external/orders/01ARZ3NDEKTSV4RRFFQ69G5FAV" \
  -H "X-API-Key: {API_KEY}"
```

### Path Parameters

| 파라미터 | 타입 | 필수 | 설명 |
|----------|------|------|------|
| `trId` | string | O | 트랜잭션 ID |

### Response

```json
{
  "code": "0000",
  "message": "success"
}
```

### 취소 조건

- 이미 취소된 주문은 재취소 불가 (에러 코드 `3005`)
- 쿠폰이 사용(교환)된 경우 취소 불가 (에러 코드 `3006`)
- 유효기간이 지난 쿠폰은 취소 불가 (에러 코드 `3007`)
- 상품 정책상 취소가 허용되지 않는 상품은 취소 불가 (에러 코드 `3009`)
- 쿠폰이 발행된 경우 협력사 취소 API가 먼저 호출되며, 협력사 취소 실패 시 에러 코드 `3004` 반환

---

## 6. SSG 쿠폰 주문 및 발송

SSG(신세계) 전용 쿠폰을 주문하고 발송합니다. 발송 방법은 항상 알림톡(`ALIM_TALK`)입니다.

### Request

```
POST /api/v1/external/orders/ssg
```

```bash
curl -X POST "https://{서버주소}/api/v1/external/orders/ssg" \
  -H "X-API-Key: {API_KEY}" \
  -H "Idempotency-Key: 7c9e6679-7425-40de-944b-e07fc1f90ae7" \
  -H "Content-Type: application/json" \
  -d '{
    "recipientPhone": "01012345678",
    "recipientName": "홍길동",
    "amount": 50000,
    "senderPhone": "01098765432",
    "message": "감사합니다"
  }'
```

### Headers

[2. 쿠폰 주문](#2-쿠폰-주문-및-즉시-발송)과 동일 (`X-API-Key`, `Idempotency-Key` 필수)

### Body Parameters

| 파라미터 | 타입 | 필수 | 설명 |
|----------|------|------|------|
| `recipientPhone` | string | O | 수신자 전화번호 |
| `recipientName` | string | O | 수신자 이름 |
| `amount` | number | O | 금액 (원) |
| `senderPhone` | string | X | 발신자 전화번호 |
| `message` | string | X | 메시지 내용 |

### Response

```json
{
  "code": "0000",
  "message": "success",
  "data": {
    "trId": "01ARZ3NDEKTSV4RRFFQ69G5FBW",
    "barCode": "8809876543210",
    "personalCode": "1234567890",
    "validStartDate": "2026-03-31",
    "validEndDate": "2026-06-29",
    "price": 50000
  }
}
```

### Response Fields

| 필드 | 타입 | 설명 |
|------|------|------|
| `trId` | string | 시스템 생성 고유 식별자 (ULID) |
| `barCode` | string? | 인증번호 |
| `personalCode` | string? | 개인번호 |
| `validStartDate` | string? | 유효기간 시작일 (YYYY-MM-DD) |
| `validEndDate` | string? | 유효기간 종료일 (YYYY-MM-DD) |
| `price` | number | 결제 금액 (원) |

---

## 7. SSG 주문 상태 조회

SSG 주문의 현재 상태를 조회합니다.

### Request

```
GET /api/v1/external/orders/ssg/:trId/status
```

```bash
curl -X GET "https://{서버주소}/api/v1/external/orders/ssg/01ARZ3NDEKTSV4RRFFQ69G5FBW/status" \
  -H "X-API-Key: {API_KEY}"
```

### Path Parameters

| 파라미터 | 타입 | 필수 | 설명 |
|----------|------|------|------|
| `trId` | string | O | SSG 주문 시 발급받은 트랜잭션 ID |

### Response

```json
{
  "code": "0000",
  "message": "success",
  "data": {
    "trId": "01ARZ3NDEKTSV4RRFFQ69G5FBW",
    "couponStatus": "NOT_USED",
    "deliveryStatus": "COMPLETE",
    "barCode": "8809876543210",
    "personalCode": "1234567890",
    "validStartDate": "2026-03-31",
    "validEndDate": "2026-06-29",
    "price": 50000
  }
}
```

### Response Fields

[3. 주문 상태 조회](#3-주문-상태-조회)의 필드에 아래 필드가 추가됩니다.

| 필드 | 타입 | 설명 |
|------|------|------|
| `personalCode` | string? | SSG 개인번호 |

`couponStatus`, `deliveryStatus` 값은 [3. 주문 상태 조회](#3-주문-상태-조회)의 상태 표를 참조하세요.

---

## 에러 코드

| 코드 | HTTP Status | 메시지 | 설명 |
|------|-------------|--------|------|
| `0000` | 200 | success | 성공 |
| `1001` | 401 | 인증 실패 | API Key가 없거나 유효하지 않음 |
| `1002` | 403 | 권한 없음 | 해당 리소스에 대한 접근 권한 없음 |
| `1003` | 429 | 요청 횟수 초과 | API Key당 분당 요청 제한 초과 |
| `1005` | 403 | SSG 미승인 계정 | 계정에 SSG 사용 권한이 없음 (SSG 주문 시도 시) |
| `2001` | 400 | 잘못된 요청 | 요청 파라미터 유효성 검증 실패 |
| `2002` | 400 | 잘못된 요청 | 요청 형식 오류 |
| `2004` | 422 | 멱등키 요청 불일치 | 동일한 `Idempotency-Key`에 다른 요청 바디로 재요청 |
| `2005` | 409 | 요청 처리 중 | 동일한 `Idempotency-Key`의 이전 요청이 아직 처리 중 |
| `3001` | 404 | 올바르지 못한 요청입니다 | 요청한 상품 코드가 유효하지 않거나 조회 권한이 없음 |
| `3002` | 402 | 잔액 부족 | 계정 잔액이 상품 가격보다 부족 (SSG의 경우 SSG 이벤트 잔액 부족 포함) |
| `3003` | 500 | 쿠폰 발행 실패 | 쿠폰 발행 또는 발송 과정에서 오류 발생 |
| `3004` | 500 | 쿠폰 취소 실패 / 재발송 불가 | 협력사 취소 API 실패 또는 쿠폰 미발행 상태에서 재발송 시도 |
| `3005` | 409 | 이미 취소된 주문 | 이미 취소 처리된 주문을 재취소 시도 |
| `3006` | 409 | 이미 사용된 쿠폰 | 사용(교환)된 쿠폰은 취소 불가 |
| `3007` | 409 | 만료된 쿠폰 | 유효기간이 지난 쿠폰은 취소 불가 |
| `3008` | 409 | 재발송 횟수 초과 | 계정별 재발송 한도(기본 3회)를 초과 |
| `3009` | 409 | 취소 불가 상품 | 상품 정책상 취소가 허용되지 않음 |
| `4001` | 404 | 주문을 찾을 수 없음 | 해당 `trId`에 대한 주문이 존재하지 않음 |
| `4002` | 404 | 접근 권한 없음 | 다른 계정의 주문에 접근 시도 |
| `9999` | 500 | 시스템 오류 | 예상치 못한 서버 오류 |

---

## 연동 흐름 예시

### 기본 주문 흐름

```
1. 상품 조회     GET  /products
2. 쿠폰 주문     POST /orders          → 응답의 trId 저장
3. 상태 확인     GET  /orders/:trId/status
4. (필요 시) 재발송  POST /orders/:trId/resend
5. (필요 시) 취소    DELETE /orders/:trId
```

### trId (트랜잭션 ID) 안내

- `trId`는 주문 시 시스템이 자동 생성하는 고유 식별자입니다 (ULID 형식, 26자 영숫자).
- 주문 API 응답에서 받은 `trId`를 저장해두고, 상태 조회·재발송·취소 시 사용합니다.
- `trId`는 비순차적으로 생성되며, 다른 계정의 `trId`를 추측하거나 접근할 수 없습니다.

### 멱등성(Idempotency) 가이드

- 모든 주문 요청에 `Idempotency-Key` 헤더를 포함해야 합니다. UUID v4를 권장합니다.
- 네트워크 오류로 응답을 받지 못한 경우, **같은 `Idempotency-Key`로 재요청**하면 기존 주문 결과가 반환됩니다.
- 새로운 주문을 하려면 **새로운 `Idempotency-Key`**를 사용하세요.
- 중복 판단 기준: `Idempotency-Key` + `X-API-Key` + API 엔드포인트

### 보안 및 접근 제한

- 모든 요청은 `X-API-Key`로 인증되며, 해당 API Key 소유자의 주문만 접근할 수 있습니다.
- 다른 계정의 `trId`로 요청하면 에러 코드 `4002`가 반환됩니다.
- API Key당 **분당 60회** 요청 제한이 적용됩니다. 초과 시 에러 코드 `1003` (429 Too Many Requests)이 반환됩니다.

### 잔액 관리

- 주문 시 상품 가격만큼 잔액이 즉시 차감됩니다.
- 쿠폰 발행 실패 시 잔액이 자동 환불됩니다.
- 주문 취소 시 잔액이 환불됩니다.
- 잔액이 부족하면 에러 코드 `3002` (402 Payment Required)가 반환됩니다.
