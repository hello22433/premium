# 해외 재고형 쿠폰 운영 런북

> 대상: `epopkon-premium` overseas-pin-inventory 기능
> rev5 §16 + ralplan T11

---

## 1. 배포 체크리스트

### 1.1 Pre-deploy
- [ ] `migration/overseas-pin-inventory.sql` 적용
- [ ] `information_schema` 제약 검증 (아래 §5 쿼리팩)
- [ ] `.env` 키 설정:
  - `PIN_INVENTORY_CRYPTO_ACTIVE_KEY_VERSION`
  - `PIN_INVENTORY_CRYPTO_KEY_RING` (실제 32바이트 hex 키)
  - `PIN_INVENTORY_HMAC_KEY` (실제 32바이트 hex 키)
- [ ] `pin_inventory_policy` 싱글턴 seed 확인 (`id=1, applications_open=0, allocation_enabled=0`)
- [ ] `direct_pin_delivery_policy` 싱글턴 seed 확인 (`id=1, send_enabled=0`)
- [ ] 기술 협력사 `partner_company` (type=`PIN_INVENTORY`) 등록
- [ ] 브랜드 등록 (Amazon, Uber, Grab 등)
- [ ] 상품 등록 + `inventory_coupon_product_config` 설정

### 1.2 Staged rollout
1. `allocation_enabled=false`, `send_enabled=false`, `applications_open=false`
2. 코드 배포 (fail-closed 상태)
3. sample PIN 테스트 발송 (실제 재고 미소비)
4. staging에서 `allocation_enabled=true` → 실제 할당·동시성 E2E
5. 운영 PIN 입고 + 저재고 알림 확인
6. `allocation_enabled=true` (운영) → 관리자 실주문 1건
7. 문제 시 즉시 `allocation_enabled=false`
8. `send_enabled=true` (발송 시작)
9. `applications_open=true` (외부 API 신청 접수)

### 1.3 PIN 입고 엑셀 양식 (이커머스 확정, 2026-08-14)

| A | B |
|---|---|
| 코드 | 유효기간 |
| VSREET2RJQXCA2 | 2027-12-31 |

- 대상 상품은 업로드 화면에서 고른다. 파일에 상품 열은 필요 없다(있으면 오업로드 방지용으로 대조한다).
- 양식 다운로드: `GET /inventory-coupons/imports/template?productId={id}`
- 헤더는 별칭을 허용한다(`코드/PIN/code/claimCode`, `유효기간/만료일/expiresOn` 등). 시트 상단 10행 안에서 헤더를 찾는다.
- **두 헤더가 모두 있어야 받는다.** 유효기간 열이 없는 파일을 받으면 전 행이 무기한 PIN 으로 들어간다. 셀 값은 비어 있어도 된다.
- 유효기간은 날짜 셀 또는 `YYYY-MM-DD/YYYY.M.D/YYYYMMDD`. 빈 칸은 무기한, KST 오늘 이전은 반려(`expiresOn/EXPIRED`).
- **코드 열은 텍스트 서식 필수.** 숫자 셀은 선행 0·정밀도가 조용히 손상되므로 `NUMERIC_CELL` 로 반려한다. 수식 오류 셀은 `INVALID_CELL`.
- 파일당 20,000행(오류 행 포함) / 10MB. **한 행이라도 틀리면 파일 전체 반려**되고 반려 사유는 엑셀 실제 행 번호로 내려온다.
- 멱등키 재요청 판정은 `파일 해시 + productId + 구매처/참조번호/구매일/매입처` 기준이다. 같은 파일을 다른 상품에 올리면 재생 응답이 아니라 새 배치다.
- 서버가 메모리에서 바로 파싱한다. 업로드 원본은 디스크에 쓰지 않는다.
- 구매처(`supplierName`)는 필수 입력값이다. 감사용이므로 실제 구매처를 적는다.

---

## 2. 장애 대응

### 2.1 재고 이상
```
PATCH /user-management/api-apps/pin-inventory-policy
{ "field": "allocationEnabled", "value": false, "expectedVersion": N }
```
→ 모든 채널의 신규 PIN 할당 즉시 중단. 기존 할당·재발송은 유지.

### 2.2 이메일 발송 장애 (send-stop)
```
PATCH /inventory-coupons/send-policy
{ "sendEnabled": false, "expectedVersion": N, "reason": "..." }
```
→ 신규 CLAIMED/decrypt/mail I/O 차단. 기존 할당·debit 유지. PAUSED 상태.

### 2.3 암호화 키 장애
- 복호화 실패 → fail closed (원문/암호문 폴백 금지)
- 신규 발송 자동 중단
- `.env` 키 복구 후 재시작

### 2.4 UNKNOWN 증가
- 자동 신규 PIN/refund 금지
- 동일 PIN 기반 운영 재처리: CS > 동일 PIN 재발송

### 2.5 데이터 drift
```sql
-- §5 쿼리팩의 drift 조회 실행
```

---

## 3. 롤백

1. 기능 플래그 닫기 (`allocation_enabled=false`, `send_enabled=false`, `applications_open=false`)
2. 외부 API entitlement 철회
3. 스키마·PIN 데이터 삭제하지 않음
4. compatibility binary 롤백 (feature binary만 제거)
5. 기존 QR/URL 이메일 경로는 additive enum으로 보존
6. 이미 할당/전송된 PIN은 ASSIGNED/VOID 유지 (AVAILABLE 일괄 복구 금지)

---

## 4. 모니터링 지표

| 지표 | 설명 | 경고 기준 |
|---|---|---|
| available per product | 상품별 가용 재고 | `lowStockThreshold` 이하 |
| allocation success/fail | 할당 성공/실패 수 | 실패 급증 |
| email SENT/FAILED/UNKNOWN | 발송 결과 분류 | UNKNOWN >3/10분 P1 |
| stale CLAIMED | 5분 초과 CLAIMED attempt | 1건이라도 P1 |
| UNKNOWN 장기 미처리 | 15분 초과 UNKNOWN | P1 |
| allocation disabled rejects | 중단 상태 거부 수 | 비정상 급증 |
| external API replay | 멱등 replay 수 | 추세 모니터링 |

---

## 5. 운영 쿼리팩

### 5.1 Migration 후 제약 검증
```sql
SELECT TABLE_NAME, CONSTRAINT_NAME, CONSTRAINT_TYPE
FROM information_schema.TABLE_CONSTRAINTS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN (
    'inventory_pin_item',
    'inventory_pin_email_attempt',
    'inventory_pin_billing_chain',
    'inventory_pin_email_outbox',
    'inventory_pin_reissue',
    'external_api_pin_inventory_request',
    'pin_inventory_policy',
    'direct_pin_delivery_policy',
    'order_delivery_refund'
  )
ORDER BY TABLE_NAME, CONSTRAINT_TYPE;
```

### 5.2 정책 싱글턴 확인
```sql
SELECT * FROM pin_inventory_policy WHERE id = 1;
SELECT * FROM direct_pin_delivery_policy WHERE id = 1;
```

### 5.3 재고 현황
```sql
SELECT
  product_id,
  code_schema_version,
  status,
  COUNT(*) cnt,
  SUM(CASE WHEN expires_on IS NOT NULL AND expires_on < CURDATE() THEN 1 ELSE 0 END) expired
FROM inventory_pin_item
WHERE deleted_at IS NULL
GROUP BY product_id, code_schema_version, status
ORDER BY product_id, code_schema_version, status;
```

### 5.4 Stale CLAIMED attempt
```sql
SELECT a.id, a.order_delivery_id, a.claimed_at, a.claim_token,
       TIMESTAMPDIFF(SECOND, a.claimed_at, NOW()) elapsed_sec
FROM inventory_pin_email_attempt a
WHERE a.status = 'CLAIMED'
  AND a.claimed_at < DATE_SUB(NOW(), INTERVAL 60 SECOND);
```

### 5.5 UNKNOWN 미처리
```sql
SELECT a.id, a.order_delivery_id, a.completed_at,
       TIMESTAMPDIFF(MINUTE, a.completed_at, NOW()) elapsed_min
FROM inventory_pin_email_attempt a
WHERE a.status = 'UNKNOWN'
  AND a.completed_at < DATE_SUB(NOW(), INTERVAL 15 MINUTE);
```

### 5.6 Assignment/outbox pair drift
```sql
SELECT i.assigned_order_delivery_id, i.status item_status,
       o.order_delivery_id, o.state outbox_state
FROM inventory_pin_item i
LEFT JOIN inventory_pin_email_outbox o
  ON o.order_delivery_id = i.assigned_order_delivery_id
WHERE i.status = 'ASSIGNED'
  AND i.deleted_at IS NULL
  AND (o.id IS NULL OR o.order_delivery_id != i.assigned_order_delivery_id);
```

### 5.7 Billing chain integrity
```sql
SELECT bc.id, bc.current_order_delivery_id, bc.state,
       od.id od_id, od.direct_pin_fulfillment_status, od.inventory_pin_billing_chain_id
FROM inventory_pin_billing_chain bc
JOIN order_delivery od ON od.id = bc.current_order_delivery_id
WHERE bc.state = 'DEBITED'
  AND od.inventory_pin_billing_chain_id != bc.id;
```

### 5.8 PREPAID_INVENTORY 정산 제외 확인
```sql
SELECT COUNT(*) must_be_zero
FROM partner_settle_ledger psl
JOIN order_delivery od ON od.id = psl.order_delivery_id
JOIN order_product_mapping opm ON opm.id = od.order_product_mapping_id
JOIN product p ON p.id = opm.product_id
WHERE p.settle_method = 'PREPAID_INVENTORY';
```

### 5.9 Refund ledger billing chain uniqueness
```sql
SELECT inventory_pin_billing_chain_id, COUNT(*) cnt
FROM order_delivery_refund
WHERE inventory_pin_billing_chain_id IS NOT NULL
GROUP BY inventory_pin_billing_chain_id
HAVING cnt > 1;
```
