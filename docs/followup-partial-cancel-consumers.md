# 후속: 발송건 부분취소가 남긴 소비자·구조 정리

> 상태: **문서화(후속 티켓 대기)**. 197-16(일반쿠폰 부분취소)에서 범위 밖으로 남긴 항목들.
> 근거: 197-16 리뷰(code-reviewer / architect lane) + 로컬 QA.
> 이 문서의 항목은 **돈이 잘못 움직이지는 않는다**(정산금액 재계산으로 difference=0 유지). 표시 불일치·구조 부채·성능·정책 확인이 핵심.

## 배경 — 왜 소비자가 갈라졌나

197-16 은 취소를 "상태 축(`status=CANCEL`)" 으로 표현하고, 정산금액 계산(`buildSettlementDisplayLines`)에서
취소 발송건을 뺐다. 그 결과 **취소를 인지하는 소비자**와 **인지하지 못하는 소비자**로 갈렸다.
공통 술어가 없어 "다 찾았는지" 를 구조적으로 보장할 방법이 없다는 것이 근본 문제다.

이번 티켓에서 고친 것:
- 상태 축 소비자 다수(정산 표시금액·리포트·forSum·완료판정 등)
- **수량 축 일부**(고객사별정산 목록·요약·엑셀) — `calculateMappingBilledQuantity` 단일 소스 신설(`51f3070`)

## A. 남은 수량 축 소비자 (표시 불일치, 돈 무관)

`mapping.amount`(원 주문 수량)를 그대로 읽어, 금액(취소 제외)과 기준이 어긋나는 자리. 위 신설 함수
`calculateMappingBilledQuantity(mapping)` 로 치환하면 된다.

- `settle.service.ts` 모바일 수익리포트 분모·총액 (대략 L897, L1087 인근 `deliveryAmount = orderProductMapping.amount`).
  `countMobileReportDeliveries` 로 분자(환불건수)만 고쳐서 한 건이 발송건수에도 환불건수에도 잡힌다.
- `order.service.ts` 발송완료리포트 헤더 수량 (대략 L1675, L2140). 행 목록은 `isDeliveryInCompleteReport`
  로 취소 제외인데 헤더는 원 수량 → **"수량 10건, 표에는 8행"** 이 고객 전달 문서에 나간다.
- `order.service.ts` 주문목록/엑셀 수량 합계 (대략 L875~, L5896~).
- 정산정보 입력/수정 화면(`getOrderSettle` 비SSG 분기, 대략 L2721~) — 화면 총액(취소 포함)과 서버 저장값
  (`calculateOrderSettlementAmount`, 취소 제외)이 어긋난다. **돈은 안 움직인다**(부분취소가 settleAmount 를
  같은 함수로 덮어 difference=0). 어긋나는 것은 표시값뿐. 운영자가 화면 근거로 저장하면 서버는 취소 반영액을 쓴다.

> 착수 시: 라인 번호는 이동하니 `mapping.amount` / `orderProductMapping.amount` 를 grep 해 금액과 짝지어
> 표시되는 자리를 전수 확인할 것. "청구 수량" 은 이제 단일 함수가 있으니 그걸 쓰면 금액과 구조적으로 일치한다.

## B. 협력사별정산 목록에 취소건이 "미사용" 으로 노출 (정책 확인 선행)

위치: `settle.service.ts` 협력사별정산 목록/엑셀(대략 L1171~, L1290~).

- 루트가 `order_delivery` 인데 **`orderDelivery.status` 필터가 없다**. 게이트는 `order.status IN
  ('DELIVERY_CONFIRMED','DELIVERY_COMPLETE')` 뿐이다.
- 종전에 발송건 CANCEL 이 생기는 두 경로(전체취소·외부API취소)는 모두 `order.status=DELIVERY_CANCEL` 을
  동반해 여기서 자연 배제됐다. **부분취소는 주문을 DELIVERY_CONFIRMED 로 남기는 첫 경로**라 그대로 통과한다.
- 취소건이 응답에 "미사용(NOT_USED)" 으로 찍혀 **아직 안 나간 정상 대기 건과 화면상 구별 불가**.
- 완화 요인: 이 목록은 원래부터 미발송 WAIT 행을 포함하는 느슨한 목록이라 새 지급 경로는 아니다.
  다만 WAIT 는 언젠가 발송돼 지급 의무가 생기고 CANCEL 은 영원히 안 생긴다(고객엔 이미 환불) — 성격이 다르다.
- **결정 필요(정산 담당)**: `andWhere('orderDelivery.status != CANCEL')` 한 줄이면 되지만, CS 폐기건 처리
  정책(`settle-fee.util.ts` "폐기만 하고 재발행 안 한 CANCEL 은 정산 반영 별도 판단")과 충돌하지 않는지 확인 후 적용.
  **판단 없이 필터만 넣지 말 것.**

## C. `orderDeliveries[0]` 대표값 패턴 (표시 null 위험)

취소 대상은 UI 에서 임의 부분집합으로 선택되므로 `[0]` 이 CANCEL 인 상황이 자연 도달한다. 그 행은
`actualSendAt`/`expireAt` 이 NULL(취소 가능 조건이 보장).

- `settle.service.ts` 정산 목록/상세/엑셀 발송시각 (대략 L1541, L1690, L1827, L2002).
- `order.service.ts` 주문상세·발송완료리포트 유효기간 (대략 L1078~, L1448, L1632~, L2082~).
- 대조군: `settle.service.ts` 의 `MIN(actual_send_at)` 집계(대략 L2340~)는 NULL 을 무시해 안전.
  즉 안전한 관용구가 이미 있고 `[0]` 패턴만 취약하다.
- 착수: `[0]` → "발송된 것 중 가장 이른 건" 으로 교체.

## D. 대량 취소의 wallet_account 락 점유 (성능)

- `deliveryIds` 상한이 1000 이라 부분취소 1회가 최대 1000 allocation line 을 한 트랜잭션에서 환불한다.
- `refund-pool.service.ts` 는 라인마다 wallet_account save + 자원별 wallet_transaction insert + ledger insert
  (포인트 주문은 usage/grant 당 추가 쿼리)를 돌리고, 그 구간 내내 `wallet_account`(정산코드=고객사 공유 행)를
  FOR UPDATE 로 잡는다.
- 500~1000건 취소 1회가 수천 statement 동안 그 행을 점유하면 같은 고객사의 다른 발송확정·환불·정산확정이
  대기한다(innodb_lock_wait_timeout 기본 50초). 기존 refund 호출부 3곳(폐기/실패환불/외부취소)은 전부 1건이라
  이 규모가 처음 열린다.
- 착수: 상한을 실측 기반으로 낮추거나(예: 200), refund-pool 의 라인 루프를 벌크화. 최소한 대량 요청의 소요시간·
  락 점유를 측정해 DTO 상한 근거에 기록.

## E. 구조 — 취소/환불 판정 술어 부재 (근본)

- `status === CANCEL` 검사가 여러 파일에 인라인 중복(customer.service / delivery.batch / settle.service /
  settle-fee.util / order.service). 공통 술어가 없다.
- "환불됨" SoT 가 두 원장으로 갈림: 발송취소=wallet 원장(`order_payment_refund_event`),
  CS 폐기=`order_delivery_refund`. 그래서 `status===CANCEL` 이 이중환불의 **주 방어선**이 됐다(안전망이 아니라).
- 부분취소 환불이 `order_delivery_refund` 를 병행 기록하지 않는다(`sourcePath: 'ORDER_CANCEL'` 이 선언만 되고 미사용).
- 착수: 두 원장 합집합을 보는 `isRefunded(deliveryId)` 술어 + `billedQuantity(mapping)`(A 에서 절반은 됨) 도출,
  `src/delivery/domain/delivery.lifecycle.ts` 신설(터미널 상수 + 순수 술어 이주) → 인라인 가드 이관.

## F. `order.receive.service.ts` couponStatus-only 가드 (심층방어 공백)

- 쿠폰 조회 진입 가드가 `couponStatus === CANCEL || REFUND_CANCEL` 만 본다. 취소건은 `couponStatus=NOT_USED` 라 통과.
- **현재 실제 도달 불가**(진입에 encryptKey 필요, 취소건은 발송된 적 없어 링크가 외부에 없음). 안전 근거가
  가드가 아니라 "링크가 없다" 는 우연. CS 진입점은 전부 명시 차단했는데 이곳만 비대칭.
- 착수: E 의 공통 술어가 생기면 함께 치환될 지점. 단독 수정 불필요.

## 프론트 (별도 레포 `epopkon-premium-front`, 읽기 전용 확인)

- **취소 경로만** 백엔드 메시지를 `alert('주문 취소에 실패했습니다.')` 로 뭉갠다(같은 파일 다른 핸들러는
  `e?.response?.data?.message || 폴백` 으로 노출). 400/409 상세 사유가 전부 죽는다 → 최소 변경으로 교체.
- **부분취소 선택 UI 선행조건**: `GET /order/detail` 이 취소가능 판정 신호 중 `status` 하나만 내려준다
  (actualSendAt/claimedAt/couponIssuedAt/barCode/reportState·발송건별 sendRequestAt 없음). 프론트 단독으로
  "선택 불가" 회색 처리가 불가능 → 백엔드 `OrderViewDeliveryDto` 에 계산된 **`cancelable: boolean`(+불가 사유)**
  추가가 사실상 선행. 컷오프(10분)는 시간 의존이라 서버 계산값을 받아야 서버와 안 어긋난다.
- 요청/응답 타입에 `deliveryIds?: number[]` / `{ canceledIds, refundedAmount, remaining }` 추가.
- `src/apis/order/type/index.ts` 의 `IOrderDeliveryItem` **중복 선언**(선언 병합으로 없는 필드를 "항상 있다" 고
  보증) 분리 — 부분취소 UI 가 발송건 필드를 참조하기 전에 선행.
- abort-dedup(직전 동일요청 취소)과 취소 버튼 더블클릭이 겹치면 "성공했는데 실패 알럿" 이 난다 → 확인 버튼 in-flight disable.

## 운영 확인(배포 전)

- **CANCEL 터미널 승격**: 배포 직후 sweep 이 기존 `DELIVERY_CONFIRMED + delivery.status=CANCEL` 조합을
  자동 완료·선정산으로 밀어 넣을 수 있다. 아래 0건 확인 후 진행:
  ```sql
  SELECT o.id, COUNT(*) FROM `order` o
  JOIN order_product_mapping opm ON opm.order_id = o.id
  JOIN order_delivery od ON od.order_product_mapping_id = opm.id
  WHERE o.status='DELIVERY_CONFIRMED' AND od.status='CANCEL' AND od.deleted_at IS NULL
  GROUP BY o.id;
  ```
- **소프트삭제 상품 섞인 발송확정 주문** 존재 여부(HIGH 수정 대상 실데이터):
  ```sql
  SELECT o.id FROM `order` o
  JOIN order_product_mapping opm ON opm.order_id=o.id
  JOIN product p ON p.id=opm.product_id
  WHERE o.status='DELIVERY_CONFIRMED' AND p.deleted_at IS NOT NULL;
  ```
- 브랜치가 upstream/develop 뒤처짐 → 리베이스 후 재검증.
