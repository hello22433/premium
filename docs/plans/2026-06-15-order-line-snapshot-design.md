# 주문 라인 시점 박제(Order Line Snapshot) 설계

날짜: 2026-06-15
상태: 설계 승인 완료 (구현 대기)
범위: 백엔드 `epopkon-premium`

## 1. 문제 정의

주문 발송완료 리포트 / 거래명세서 / 정산 등 **문서**가 렌더 시점에 LIVE 테이블을
조인해 데이터를 읽는다. 특히 `orderProductMapping.product.price`(상품 단가)가 LIVE다.
주문 이후 협력사가 상품 가격·이름·브랜드를 바꾸면 과거 주문 문서가 바뀐 값으로 표시된다.
= 과거 주문이 다른 주문이 되어버림.

예: 1,000원 상품 주문 → 발송 전 협력사가 1,500원으로 인상 → LIVE 조회 시 문서에 1,500원 표시.
고객은 1,000원으로 주문했으므로 1,000원이 보여야 한다.

### 이미 박제된 것 (추가 안 함)
- `order.snapshot*` (user/company 정보, 주문 생성 시점)
- `orderProductMapping.fee`, `priceAdjustment`, `settleDiscountType` (할인/수수료)
- `orderProductMapping.amount` (수량)
- 발송 내용 (`sendTitle`, `sendContent`, `fromPhoneNumber`, `fromEmail` 등)
- `orderDelivery.expireAt` (산출되어 저장된 값)
- `order.sendAmount` / `settleAmount` (청구액 — updateTemp 시점 박제·저장)

### 구멍 (LIVE로 남아있는 것)
- 상품 단가 `product.price`
- 상품명 `product.name`
- 브랜드명 `product.brand.nameKorean`
- 유효기간일수 `product.expireDay`
- 이미지 `product.imagePath`

## 2. 데이터 모델 (Section 1)

`order_product_mapping` 테이블에 nullable 컬럼 신규 추가:

| 컬럼 | 타입 | 비고 |
|---|---|---|
| `snapshotProductPrice` | int | **핵심(돈)**. product.price와 동일 int (TypeORM decimal 문자열 반환 회피) |
| `snapshotProductName` | varchar | |
| `snapshotProductBrandName` | varchar | |
| `snapshotProductExpireDay` | int | |
| `snapshotProductImagePath` | varchar null | |

- 박제 단위 = **mapping id (행 단위)**. 같은 productId 중복행도 각자 독립 snapshot. productId 기준 승계 금지.

## 3. 박제 / 승계 규칙 (Section 2) — CLOSED

### createTemp (최초 INSERT)
각 OPM 행 저장 시 LIVE product(brand relation 포함 조회)에서 5필드 1회 박제.

### updateTemp 승계 규칙
현재 `updateTemp`는 orderId로 OPM/delivery 전삭제 후 재생성(새 id). DTO에 라인별
`id?`(mapping id) 이미 존재하나 무시 중. 다음으로 변경:

트랜잭션 순서 보장: **조회 → 검증 → 삭제 → 재생성**

1. 삭제 전 기존 OPM 적재: `Map<oldMappingId, { productId, snapshot }>`
2. 검증:
   - `line.id`가 전달됐는데 해당 주문 소유(map 멤버)가 아니면 → **무조건 400** (신규행 취급 금지, 우회 차단)
   - 요청 내 `line.id` 중복 등장 → **400** (주문 소유 + 1회만)
3. 행별 snapshot 결정:

| 케이스 | 동작 |
|---|---|
| `line.id` 있음 + map의 동일 productId | 기존 snapshot **값 승계** |
| `line.id` 있음 + productId 변경(상품 교체) | LIVE에서 **신규 박제** |
| `line.id` 없음(신규 행) | LIVE에서 **신규 박제** |

- 화면 기존 행은 수정 요청에 `line.id` 필수 전송. 누락 = 의도적 신규행 = LIVE 박제.
- legacy NULL 행은 이 단계서 재박제 안 함 → Section 5 backfill 정책 적용.
- "향후 명시적 snapshot 직접수정"은 현재 범위에서 **제거** (DTO에 snapshot 편집 필드 없음).
- 발송요청 이후 재박제 금지. updateTemp는 TEMP/DELIVERY_CANCEL만 허용(자연 차단) + 명시 가드.

## 4. 읽기 helper + 소비처 (Section 3) — 이번 PR = T2만

`order.snapshot.builder.ts`에 중앙 helper 신설:

```
readLineProductView(opm) → {
  name:      opm.snapshotProductName      ?? opm.product?.name              ?? '(삭제된 상품)',
  price:     opm.snapshotProductPrice     ?? opm.product?.price             ?? 0,
  brandName: opm.snapshotProductBrandName  ?? opm.product?.brand?.nameKorean ?? '',
  expireDay: opm.snapshotProductExpireDay  ?? opm.product?.expireDay         ?? 0,
  imagePath: opm.snapshotProductImagePath  ?? opm.product?.imagePath         ?? null,
}
```
레거시 NULL → LIVE fallback → null 에러 없음 (기존 `readBillingView` 패턴과 동일).

### 이번 PR 전환 대상 = T2 (문서)
- `order.service.ts`: 발송완료 리포트 / 거래명세서 / multiple 변형 / 정산 빌더 (price/name/brand/expireDay/imagePath)
- `settle.service.ts`: 정산 상세/기간별 (price)

### 후속 PR로 분리 (이번 범위 아님)
- **T1 발송경로(고위험)**: `delivery.batch.service.ts`, `delivery.send.service.ts`, 문자/알림톡 템플릿, `external_api.service.ts`. 실제 발송물·외부 API. SSG/초이스 엣지 많음.
- **T3 CS 표시**: `customer.service.service.ts`.
- 컬럼은 이번 PR에서 채워지므로 후속 PR이 즉시 소비 가능.

### 주의
- `expireDay`는 `expire.util.ts` 유효기간 산출 입력. 단 `orderDelivery.expireAt` 저장값 우선(재계산 금지). snapshot expireDay는 미산출 fallback 경로에만 영향.
- `choiceSelectProduct`(초이스 선택상품)는 선택 시점이 진실 → snapshot 대상 아님.

## 5. divergence 플래그 + 프론트 (Section 4)

주문 상세 API 라인별 필드 추가:
```
priceChanged: boolean       // snapshot 있고 snapshotProductPrice !== 현재 product.price
snapshotPrice: number|null  // legacy NULL이면 null
currentPrice: number|null   // 삭제상품이면 null
```
- 읽기 시점 계산. 별도 배치/스캔 불필요(가격변경·확정 두 케이스 자동 커버).
- legacy NULL → `priceChanged=false`. 삭제상품 → `currentPrice=null, priceChanged=false`.

프론트 spec → `0_ePOPKON/forFront/` md 작성 (프론트 repo 직접수정 안 함):
- 자사 운영자 주문 상세 페이지에서 `priceChanged=true` 라인에 경고 배너/뱃지.
- 문구 예: "주문 시점 단가 {snapshotPrice}원 → 현재 협력사 단가 {currentPrice}원. 문서는 주문시점 단가로 발행됩니다."

## 6. Legacy backfill + 테스트 (Section 5)

### Backfill migration
- snapshot NULL 행 → 5필드 채움. price는 **단일 OPM 주문 우선 역산**:
  - 단일라인: `원본단가 = order.sendAmount / amount` (결정론적 정확 복원)
  - 가드: `amount > 0` 그리고 나눠떨어질 때만. 아니면 역산 불가.
  - 다중라인 / amount=0 / 나눠떨어짐X / sendAmount null → 역산 불가 → LIVE product.price fallback
- **역산 불가 행은 migration이 리포트(로그/카운트)로 식별 출력**. 어떤 주문이 LIVE fallback됐는지 확인 가능.
- name/brand/expireDay/imagePath는 LIVE product에서 backfill (역산 불가, best-effort).
- 삭제상품 행 → NULL 유지 → 읽기 helper fallback.
- 한계 명시: 주문 후 backfill 전 이미 가격이 바뀐 다중라인 legacy는 원본가 복원 불가.
  청구액은 `order.sendAmount`에 이미 박제되어 영향 없음(문서 표시용 한정).

### 테스트
- 단위 `readLineProductView`: snapshot有/NULL/삭제상품 fallback 매트릭스
- 단위 `updateTemp` 승계: 동일id+동일productId 승계 / productId교체 재박제 / 신규행 박제 /
  타주문 id→400 / 요청내 중복id→400 / 트랜잭션 순서(조회→검증→삭제→재생성)
- 단위 `createTemp`: 5필드 전부 박제 (brand relation 포함 조회 확인)
- 단위 divergence: changed / unchanged / legacy-null / 삭제상품
- 통합: 상품가 변경 후 리포트/명세서/정산이 snapshot 값 출력(LIVE 아님)
- migration: backfill legacy 채움 + 단일라인 역산 + 역산불가 식별 리포트
