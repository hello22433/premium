# [FE 요청서] 주문접수 — 자동주문(미리보기/승인/결과조회) API 계약

- **대상 레포**: `epopkon-premium-front`
- **핵심 파일**: `src/apis/order-receipt/type.ts` (`TOrderReceiptAutoResult` 계열), 주문접수 상세/승인 화면
- **백엔드 상태**: 구현 완료(PR #7 `feat/order-receipt-auto-order`). 아래 계약은 **백엔드가 실제로 내려주는 형태**를 코드에서 그대로 추출한 정본.
- **관련 리뷰**: PR #7 dlrltjd 리뷰 17건 반영 완료(계약 항목 A그룹 구현 / 결정 항목 B그룹 처리).

> 이 문서는 자동주문 기능의 **첫 FE 요청서**입니다(이전 버전 없음). 프론트 `type.ts`를 이 계약에 맞춰 정렬해 주세요.

---

## 0. 한눈에 — 엔드포인트 3종

| 액션 | Method · Path | Body | 응답 | 권한 |
|---|---|---|---|---|
| 미리보기 | `POST /order-receipt/:id/preview` | `{ fileIndexes?: number[] }` | `AutoOrderResultDto` (`mode=PREVIEW`, 이미 승인됐으면 `COMMITTED`) | 운영관리자 이상 |
| 승인 | `PUT /order-receipt/:id/approve` | 없음 | `AutoOrderResultDto` (`mode=COMMITTED`) | 운영관리자 이상 |
| 결과조회 | `GET /order-receipt/:id/result` | 없음 | `AutoOrderResultDto` (`mode=COMMITTED`) / 없으면 404 | 운영관리자 이상 |

- **미리보기**는 DB를 바꾸지 않습니다(DRY_RUN). "승인하면 무엇이 생성/차단되는지"를 계산해 보여줍니다.
- **승인**이 실제로 임시(TEMP) 주문을 생성하고, 그 리포트를 **스냅샷으로 저장**합니다.
- **결과조회**는 저장 스냅샷을 그대로 반환합니다(재계산 없음).
- 이미 승인된 건을 **미리보기 호출하면**, 재계산 대신 저장 스냅샷(`mode=COMMITTED`)을 반환합니다 → 프론트는 미리보기/결과조회 응답 타입을 동일하게 다루면 됩니다.

---

## 1. 요청 (Request)

### 1-1. 미리보기 Body
```ts
// POST /order-receipt/:id/preview
interface OrderReceiptPreviewReq {
  fileIndexes?: number[]; // 미리보기 대상 파일 인덱스(filePath 목록 기준, 0부터). 생략/빈 배열이면 전체 파일. 최대 10개.
}
```
- `fileIndexes`는 `order_receipt.filePath`(첨부 URL 목록)의 **인덱스**입니다. 선택 여부와 무관하게 인덱스는 전체 목록 기준으로 고정됩니다(멱등키·리포트 식별 안정성).
- 승인(`approve`)에는 Body가 없습니다 — 승인은 항상 전체 파일을 처리합니다.

---

## 2. 응답 (Response) — `AutoOrderResultDto`

세 엔드포인트 모두 **동일한 최상위 타입**을 반환합니다.

```ts
type AutoResultMode = 'PREVIEW' | 'COMMITTED';

interface AutoOrderResultDto {
  mode: AutoResultMode;      // PREVIEW=미리보기(미변경) / COMMITTED=승인되어 실제 생성됨
  receiptId: number;
  generatedAt: string;       // ISO 8601. COMMITTED면 승인 시각, PREVIEW면 계산 시각
  files: AutoOrderFileResultDto[];
  summary: {
    fileCount: number;       // 처리한 파일 수
    validFileCount: number;  // status==='VALID'인 파일 수
    totalOrderCount: number; // 전체 파일에서 생성(예정)된 주문 건수 합
    allMatched: boolean;     // VALID 파일들의 검산(reconciliation.matched)이 모두 통과했는가
  };
}

interface AutoOrderFileResultDto {
  targetFilePath: string;    // 파싱 대상 파일 경로(표시명 도출용)
  fileIndex: number;         // filePath 목록 기준 인덱스
  status: 'VALID' | 'INVALID_FORMAT' | 'ALREADY_COMMITTED';
  formatError: { code: FormatErrorCode; message: string } | null; // status==='INVALID_FORMAT'일 때만 non-null
  reconciliation: {
    inputRowCount: number;        // 발송명단 총 행수
    expectedDeliveryCount: number;// 생성돼야 할 발송건수(독립 산출)
    builtDeliveryCount: number;   // 실제 생성(예정) 발송건수
    matched: boolean;             // 두 값이 일치(사유 없는 누락/중복 없음)
  };
  orders: AutoOrderOrderDto[];
  unmappedRows: { rowNo: number; code: string; reason: string }[]; // 미등록 상품코드 행(code=상품코드)
  warningRows:  { rowNo: number; code: BlockCode; reason: string }[]; // 행 단위 차단(금칙어/수신처 등)
  excludedRows: { rowNo: number; reason: string }[]; // 엑셀이 스스로 무효표시(_유효=False)한 행
}

interface AutoOrderOrderDto {
  orderId: number | null;    // PREVIEW=null, COMMITTED=생성된 order.id
  type: 'GENERAL' | 'SSG';   // 자동주문이 만드는 주문 종류(현재 이 둘만)
  eventName: string;
  productCount: number;      // 상품 종수
  deliveryCount: number;     // 발송건 수(=수신자 수)
  products: {
    productId: number | null;
    productName: string;
    code: string;
    faceValue: number;       // 정상가(product.price)
    deliveryCount: number;   // 이 상품의 발송건 수
  }[];
}
```

### 2-1. `mode` 별 차이 (프론트 분기 포인트)
| | `PREVIEW` | `COMMITTED` |
|---|---|---|
| 언제 | 미승인 건 미리보기 | 승인 직후 / 결과조회 / 승인된 건 미리보기 |
| `orders[].orderId` | `null` | 실제 order.id |
| DB 변화 | 없음 | 주문 생성됨 |
| 재호출 | 매번 재계산 | 저장 스냅샷 고정(SSG 예약창 등 시간의존 결과도 승인 당시로 고정) |

---

## 3. 코드/enum 표 (프론트 상수와 정렬 필요)

### 3-1. `FormatErrorCode` — 파일 형식 실패 (`formatError.code`)
| code | 의미 |
|---|---|
| `NOT_XLSX` | 파일을 읽지 못함/비표준(손상, 0바이트, 크기초과 20MB, 비-xlsx) |
| `MISSING_SHEET` | 필수 시트 없음 |
| `HEADER_MISMATCH` | 헤더/양식 불일치(수식 미캐시·행수초과 포함) |
| `VERSION_MISMATCH` | 양식 버전 불일치(v4.1 아님) |
| `EMPTY_LIST` | 발송명단이 비어 있음 |

> `INVALID_FORMAT`은 "고객사 자체 양식" 등 **정상 케이스일 수 있어 승인은 막지 않습니다.** 프론트는 해당 파일을 "자동주문 대상 아님/확인 필요"로 표시하고, 나머지 VALID 파일은 정상 진행하면 됩니다.

### 3-2. `BlockCode` — 행 단위 경고 (`warningRows[].code`)
| code | 의미 |
|---|---|
| `FORBIDDEN_WORD` | 대치문자에 금칙어 |
| `MISSING_DELIVERY_TARGET` | 발송수단에 맞는 수신처 없음(문자=휴대폰 / 이메일=이메일) |
| `INVALID_DELIVERY_TARGET` | 수신처는 있으나 형식 불량(이메일/휴대폰 형식 아님) |
| `SSG_RESERVATION_WINDOW` | SSG 예약 가능창 밖(주문 단위 스킵) |
| `SEND_METHOD_NOT_ALLOWED` | 이 계정에 허용되지 않은 발신수단 |
| `RECEIPT_OWNER_MISSING` | 접수 소유자(기업 사용자) 조회 실패 |
| `EMAIL_SENDER_MISSING` | 이메일 발신주소 확보 실패 |

> `SEND_METHOD_NOT_ALLOWED`, `RECEIPT_OWNER_MISSING`, `EMAIL_SENDER_MISSING`, 제목/내용 금칙어는 **파일 전체 차단(FILE 레벨)** → 그 파일의 `orders`는 0건이 됩니다. `warningRows`는 행 레벨(그 행만 제외)입니다.

### 3-3. `status`
| status | 의미 |
|---|---|
| `VALID` | 자동주문 대상(orders/warningRows 등 채워짐) |
| `INVALID_FORMAT` | 양식 아님(`formatError` 참조, 승인은 무해 통과) |
| `ALREADY_COMMITTED` | 멱등 재처리로 저장 스냅샷 반환된 파일 |

---

## 4. 상태 흐름 (권장 UX)

```
[상세화면] ──(미리보기)──► POST /preview
     │                         └─ mode=PREVIEW: orderId=null, "이대로 승인하면 N건 생성/ M건 차단"
     │
     ├──(승인)──────────────► PUT /approve
     │                         └─ mode=COMMITTED: orderId 채워짐 → 생성 완료 화면
     │
     └──(재방문/새로고침)───► GET /result
                               └─ 있으면 COMMITTED 스냅샷 / 없으면 404(미승인)
```

- **승인 버튼 노출 조건 권장**: `summary.allMatched === true` && FILE 차단(파일 orders 0건 + fileBlocked성 warning) 없음일 때 활성. 검산 불일치(`matched===false`)는 백엔드가 승인 시 롤백하므로, 프론트도 미리 경고 표시 권장.
- **검산(reconciliation)**: `expectedDeliveryCount !== builtDeliveryCount`면 `matched=false` → "행이 사유 없이 누락/중복"이라는 코드버그 신호. 이 경우 승인은 백엔드가 막습니다(아래 5).

---

## 5. 에러 응답

| 상황 | HTTP | 처리 |
|---|---|---|
| 접수 건 없음 | 400 | "존재하지 않는 주문접수" |
| 권한 부족(운영관리자 미만) | 403 | 버튼 비노출/토스트 |
| 결과 스냅샷 없음(`GET /result`, 미승인) | 404 | "승인 전이거나 자동주문 대상 아님" — 정상 분기로 처리 |
| 동시 승인 경합 / 재승인 중복 | 409 | "이미 처리 중이거나 처리된 승인입니다. 잠시 후 결과를 확인하세요." → `GET /result` 재조회 유도 |
| 재승인인데 첨부가 바뀜(해시 불일치) | 400 | "승인 당시 첨부와 현재 첨부가 다릅니다" — 재검토 유도 |
| 검산 불일치로 승인 롤백 | 500대/에러 | 승인 실패(주문 미생성). 재시도 전 담당자 확인 |

---

## 6. 프론트에서 건드릴 것 / 안 건드릴 것

**할 것**
- `type.ts`의 `TOrderReceiptAutoResult`(및 하위 타입)를 2절 형태로 정렬 — 특히 `mode`, `formatError`, `reconciliation`, `warningRows[].code`(BlockCode), `orders[].type`(GENERAL/SSG).
- 미리보기/결과조회를 **동일 렌더러**로 처리(둘 다 `AutoOrderResultDto`).
- 3-1/3-2 코드 표를 한글 라벨 상수로 매핑(사용자 노출 문구).

**안 할 것 / 확인 필요(백엔드에 회신 주세요)**
- **(확인①) 계약 정본**: 위 필드명이 프론트 `type.ts`와 어긋나는 항목이 있으면 알려주세요. 백엔드는 프론트 기존 타입에 맞추는 것을 우선했으나, `sendParams/settlement/orderDeliveryList/fileWarnings` 등 프론트가 optional로 두던 필드는 **현재 미제공(후속 단계)** 입니다.
- **(확인②) `GET /result` 범위**: 이 엔드포인트가 이번 PR 범위에 포함되는지(프론트가 승인 응답만 쓰고 결과조회는 안 쓸 계획이면 알려주세요 — 백엔드는 새로고침/재방문 대비로 추가함).

---

## 부록: 백엔드 참고 위치 (이해용 — 프론트 수정 대상 아님)
- 계약 매퍼: `src/order_receipt/application/auto_order/auto.order.result.mapper.ts` (`AutoOrderResultDto`)
- 컨트롤러: `src/order_receipt/api/order.receipt.controller.ts` (`/preview`, `/result`, `/approve`)
- 미리보기/승인/결과 서비스: `src/order_receipt/application/order.receipt.service.ts`
- 코드 정의: `src/order_receipt/application/auto_order/auto.order.types.ts` (`FormatErrorCode`, `BlockCode`)
