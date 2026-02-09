# 갤럭시아 정산 화면 작업 명세

## 개요

협력사 정산 메뉴(`/settlement/partner-company`)에 **갤럭시아 정산** 탭을 추가합니다.

갤럭시아 상품권은 부분 사용이 가능하므로, **사용일자(appDay) 기준**으로 건별 사용내역을 조회/엑셀 다운로드하는 화면이 필요합니다.

**기존 협력사 정산 화면 변경사항**: 기존 `/settle/partner-company/list` API에서 갤럭시아 타입이 **자동으로 제외**됩니다. 프론트엔드에서는 기존 탭의 추가 변경이 필요 없습니다.

---

## API 명세

### 1. 목록 조회

- **URL**: `GET /settle/galaxia/list`
- **권한**: `SETTLE_PARTNER_COMPANY`

#### Query Parameters

| 파라미터 | 타입 | 필수 | 설명 |
|----------|------|------|------|
| page | number | N | 현재 페이지 (기본 1) |
| take | number | N | 조회 개수 (기본 10) |
| startAt | string | N | 사용일자 시작 (`yyyy-MM-ddTHH:mm:ss`) |
| endAt | string | N | 사용일자 끝 (`yyyy-MM-ddTHH:mm:ss`) |
| businessName | string | N | 고객사 명 (LIKE 검색) |
| appDiv | string | N | 거래구분 코드 (`10`/`20`/`25`/`81`) |

#### Response

```json
{
  "list": [
    {
      "id": 1,
      "orderDeliveryId": 123,
      "barcode": "1234567890",
      "appDiv": "10",
      "appDivName": "사용",
      "appDay": "20250131",
      "appTime": "143025",
      "amount": 3000,
      "appNo": "A12345",
      "appStore": "CU 강남점",
      "giftKind": "cpn",
      "productName": "갤럭시아 모바일쿠폰 5000원",
      "productPrice": 5000,
      "galaxiaBalance": 2000,
      "userBusinessName": "ABC 주식회사",
      "eventName": "설날 이벤트",
      "code": "EP001",
      "partnerCompanyName": "갤럭시아머니트리"
    }
  ],
  "totalPage": 5,
  "totalCount": 48,
  "currentPage": 1
}
```

### 2. 엑셀 다운로드

- **URL**: `POST /settle/galaxia/excel-download`
- **권한**: `SETTLE_PARTNER_COMPANY`

#### Request Body

| 파라미터 | 타입 | 필수 | 설명 |
|----------|------|------|------|
| startAt | string | N | 사용일자 시작 (`yyyy-MM-ddTHH:mm:ss`) |
| endAt | string | N | 사용일자 끝 (`yyyy-MM-ddTHH:mm:ss`) |
| businessName | string | N | 고객사 명 |
| appDiv | string | N | 거래구분 코드 |
| password | string | Y | 비밀번호 (다운로드 확인용) |
| downloadReason | string | Y | 다운로드 사유 |

#### Response

파일 다운로드 (xlsx)

---

## 화면 구성

### 탭 구조

기존 협력사 정산 페이지에 탭 추가:
- **협력사 정산** (기존 - 갤럭시아 제외됨)
- **갤럭시아 정산** (신규)

### 필터 영역

| 필터 | UI 타입 | 기본값 | 설명 |
|------|---------|--------|------|
| 사용일자 범위 | DateRangePicker | 이번 달 1일 ~ 오늘 | startAt/endAt |
| 고객사 명 | 텍스트 입력 | 빈 값 | businessName |
| 거래구분 | 셀렉트박스 | 전체 | appDiv |

**거래구분 셀렉트박스 옵션**:
| 값 | 표시 텍스트 |
|----|------------|
| (빈값) | 전체 |
| 10 | 사용 |
| 20 | 사용취소 |
| 25 | 망취소 |
| 81 | 환불등록 |

### 테이블 컬럼

| 순서 | 컬럼명 | 필드 | 정렬 | 비고 |
|------|--------|------|------|------|
| 1 | 고객사 | userBusinessName | - | |
| 2 | 이벤트명 | eventName | - | |
| 3 | EP코드 | code | - | |
| 4 | 상품명 | productName | - | |
| 5 | 상품금액 | productPrice | - | 원 단위 포맷 |
| 6 | 바코드 | barcode | - | |
| 7 | 거래구분 | appDivName | - | 한글 표시 |
| 8 | 사용일자 | appDay | - | YYYY-MM-DD 포맷 변환 |
| 9 | 사용시간 | appTime | - | HH:mm:ss 포맷 변환 |
| 10 | 사용금액 | amount | - | 원 단위 포맷 |
| 11 | 승인번호 | appNo | - | |
| 12 | 사용처 | appStore | - | |
| 13 | 상품권종류 | giftKind | - | cpn=쿠폰, dept=백화점상품권 |
| 14 | 현재잔액 | galaxiaBalance | - | 원 단위 포맷 |

### 기능

- **페이지네이션**: 기존 협력사 정산과 동일한 방식
- **엑셀 다운로드 버튼**: 클릭 시 비밀번호/사유 입력 모달 표시 (기존 협력사 정산 엑셀 다운로드 모달과 동일)
- **날짜 포맷 변환**: appDay `20250131` → `2025-01-31`, appTime `143025` → `14:30:25`

---

## 거래구분 코드표

| 코드 | 한글 | 설명 |
|------|------|------|
| 10 | 사용 | 정상 사용 (사용금액이 정산 대상) |
| 20 | 사용취소 | 사용 취소 (정산에서 차감 대상) |
| 25 | 망취소 | 네트워크/시스템 취소 |
| 81 | 환불등록 | 환불 처리 |

---

## 정산 기준 설명

- **사용일자(appDay) 기준**: 12/31에 100원 사용 → 12월 정산에 포함, 1/1에 3000원 사용 → 1월 정산에 포함
- **동일 핀 여러 건**: 5000원 상품권을 여러 날에 걸쳐 사용하면, 각 사용건이 별도 행으로 표시
- **미사용분**: 유효기간 만료 시 별도 처리 없음 (사용한 만큼만 정산)
