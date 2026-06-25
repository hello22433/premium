# Simplify 체크리스트

## Phase 1: 즉시 수정 (보안/버그/dead code)

### 1-1. console.log 제거 (보안)

- [x] `common/infra/crypto.cipher.ts:21` — console.log('encrypted:') 삭제
- [x] `order/application/order.service.ts:3144` — console.log('주문내역조회') 삭제
- [x] `partner_company_extern/infra/culture.socket.ts` — console.log → logger 교체

### 1-2. 버그 수정

- [x] `entity/user.sync.product.event.entity.ts` — @Column() adminUserId 추가
- [x] `partner_company_extern/infra/culture.socket.ts` — 죽은 socket.io 코드 + URL 버그 삭제
- [x] `common/api/dto/get.list.res.dto.ts` — totalCount 설명 오류 수정
- [x] `order/application/order.service.ts` — updateTemp 이미지 경로 중복 할당 단순화

### 1-3. Dead code 삭제

- [x] `customer_service/domain/customer.service.pin.status.ts` — 중복 enum 파일 삭제
- [x] `partner_company_extern/batch.service.ts` — checkLegacy() 삭제
- [x] `partner_company_extern/batch.service.ts` — COUPON_STATUS_VALUES 삭제
- [x] `partner_company_extern/infra/galaxia.http.ts` — 이미 깨끗함 (주석 코드 없음)
- [x] `customer_service/api/dto/customer.service.detail.view.dto.ts` — 주석 50줄 삭제
- [x] `settle/application/settle.service.ts` — 주석 dead code 삭제
- [x] `settle/settle.schedule.ts` — 주석 bootstrap 삭제
- [x] `order/application/order.service.ts` — 생성자 주석 @Inject 삭제, vat 주석 삭제
- [~] `order/application/order.service.ts` — 주석 andWhere/임시비활성화 (의도적 비활성화, 보류)
- [x] `product/application/product.service.ts` — isValidRow 미사용 삭제
- [x] `product/api/product.req.dto.ts` — ProductGetLikeListReqDto 미사용 삭제
- [x] `util/convertToBoolean.util.ts` — 미사용 파일 삭제
- [x] `util/digits.ts` — extractNumberFromString 미사용 삭제

### 1-4. Unused import/injection 정리

- [x] `partner_company_extern/infra/giftishow.http.ts` — CryptoCipher 제거
- [x] `partner_company_extern/infra/giftiel.http.ts` — CryptoCipher 제거
- [x] `customer_service/api/dto/customer.service.dlvry.detail.view.dto.ts` — IOrderSendMethod 미사용 확인 (이미 import 없음)

## Phase 2: 공통 유틸리티 추출

- [x] decrypt+mask 헬퍼 추출 → `CryptoCipher.safeDecryptDeliveryTarget()` (9개 파일 적용)
- [x] parseDateString 추출 → `util/date.util.ts` (2개 파일 중복 제거)
- [x] sleep() util 추가 → `util/time.util.ts`
- [x] parseFilePathList() 추출 → `util/file.util.ts` (5개 서비스 적용)
- [x] mask.barcode.util → MaskingUtil 통합 (파일 삭제, order.service.ts 업데이트)
- [x] applyReplaceCharacters 공유 → `common/utils/replace-characters.util.ts` (4개 파일 인라인 → import)
- [x] couponStatusToKorean 공통 헬퍼 추출 → `order.delivery.coupon.status.ts` (settle, customer_service 적용)

## Phase 3: 서비스별 중복 제거 + Phase 4: Stringly-typed 코드 정리

### 3/4-1. order

- [x] `order.excel.mapping.ts` — if-chain → Record 룩업 전환
- [~] order.req.dto OrderSearchTypeEnum — 기존 코드에 영향 범위 큼, 보류
- [~] createTemp/updateTemp 루프 통합 — 차이가 미묘하여 리스크 대비 효과 낮음, 보류
- [~] createOrderSettle/updateOrderSettle 공유 셋업 — 사후 처리 로직 차이로 통합 어려움, 보류

### 3/4-2. settle

- [~] settle DTO 상속으로 중복 제거 — API 계약 변경 리스크, 보류
- [~] settle 쿼리빌더 추출 — getMobileList/mobileExcelDownload 등, 구조 차이로 보류
- [~] settle IOrderStatus enum 사용 — 8곳+ 문자열 리터럴, 개별 파일 변경 리스크 높음, 보류

### 3/4-3. product

- [~] getTotalList/getList 통합 — 필터 차이 있어 리스크 대비 효과 낮음, 보류
- [~] sync-product 필터 추출 — 3곳 중복이나 미묘한 차이 있어 보류

### 3/4-4. partner_company_extern

- [~] partner check 로직 통합 (batch vs service) — 비즈니스 로직 변경 위험, 보류

### 3/4-5. delivery + customer_service

- [x] `applyReplaceCharacters` 공유 유틸 추출 (Phase 2에서 완료)
- [x] `safeDecryptDeliveryTarget` 공유 메서드 추출 (Phase 2에서 완료)
- [~] customer_service switch(partnerType) 전환 — execPinStatusModify 비즈니스 로직 변경 리스크, 보류

### 3/4-6. common/util/entity

- [x] `maskBarCode` → MaskingUtil 통합 (Phase 2에서 완료)
- [x] `couponStatusToKorean` 공통 헬퍼 (Phase 2에서 완료)
