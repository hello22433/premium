# [후속/별도 티켓] 발송실패목록 기준일시 — 전환 건 축 불일치와 남은 비대칭

> 이 문서는 PR #96(발송실패목록 기준일시 폴백에 `send_request_at` 삽입) 작업 중 확인한
> **범위 밖 이슈와 미결 결정**을 추적한다. PR 리뷰/코멘트 시 이 파일을 참조할 것.
> PR #96 자체(파기 배치가 옛 건을 당일로 되살리던 경로 차단)는 이 이슈들과 무관하게 정상 동작한다.

관련 코드: `src/partner_company_extern_history/application/partner.company.extern.history.service.ts`

---

## 1. 전환 건은 검색·정렬 축과 화면 축이 다르다

| | 필터·정렬 (SQL) | 화면 표시 (TS) |
|---|---|---|
| **미전환 건** | `LIST_DATE_EXPR` ②~⑤ | `legacyDisplayDate` ②~⑤ — **일치** |
| **전환 건** | ① `wf.state_entered_at` | `sot.lastResolvedAt` — **다름** |

`state_entered_at` 은 `RESOLVED_MANUALLY_*` 로 넘어갈 때 갱신된다. 운영자가 나중에 수동 종결하면
화면에는 실패 시각이 뜨는데 검색은 종결 시각으로 걸려, **화면 날짜로 검색해도 안 나온다.**
PR #96 이 고친 증상과 같은 형태다.

또한 `LIST_DATE_EXPR` 의 ④⑤ 는 전환 건에 **닿지 않는다** — `sot.lastResolvedAt` 이
`stateEnteredAt`(NOT NULL DEFAULT CURRENT_TIMESTAMP(6))으로 폴백해 절대 null 이 되지 않기 때문이다.

### 2026-08-14 운영 실측

전환 **0건** / shadow 기록 19,137건 중 이 목록 대상 60건:

| workflow_status | 행수 | 두 축 날짜 불일치 |
|---|---|---|
| `FAILED_FINAL` | 45 | **0** — 실제로 실패한 건은 문제없다 |
| `OPS_REVIEW_REQUIRED` | 15 | 재료 있는 10건 중 **9건**. 5건은 재료(결론 시각) 자체가 없다 |
| `RESOLVED_MANUALLY_FAILED` | 0 | — |
| `RESOLVED_MANUALLY_REFUNDED` | 0 | — |

`OPS_REVIEW_REQUIRED` 는 **아직 실패한 것이 아니라** SLA 초과 승격이다. "실패 시각" 이라는 값 자체가 없다.

### 그래서 이건 버그 수정이 아니라 업무 결정이다

> **아직 실패하지 않은 건의 "발생일시" 는 무엇이어야 하는가?**

| 후보 | 5건(재료 없음)은? |
|---|---|
| 마지막 시도 결론 시각 (현행 화면) | **비어 있음** |
| 승격 시각 (`ops_escalated_at`) | 채워져 있음 |
| 발송 요청 시각 | 채워져 있음 |

**운영 확인 전까지 코드로 통일하지 말 것.** 어느 답이냐에 따라 구현이 달라진다.

---

## 2. ⚠️ 컷오버(전환) 시작 **전에** 다시 확인할 것

아래 값들은 2026-08-14 기준이고 시간이 지나면 거짓이 된다. **첫 전환 건이 생기기 전에** 재확인한다.

```sql
-- ① 수동 종결 건이 생겼나. 생기면 실제 실패 건인데 날짜가 종결일로 밀린다.
SELECT COUNT(*) FROM delivery_workflow
WHERE workflow_status IN ('RESOLVED_MANUALLY_FAILED','RESOLVED_MANUALLY_REFUNDED');

-- ② 위 60건 대조 재실행 — FAILED_FINAL 불일치가 0 을 유지하는지
SELECT wf.workflow_status AS 상태, COUNT(*) AS 행수,
       SUM(ev.resolved_at IS NULL) AS 재료없음,
       SUM(DATE(wf.state_entered_at) <> DATE(ev.resolved_at)) AS 날짜어긋남
FROM delivery_workflow wf
LEFT JOIN (
    SELECT order_delivery_id, MAX(resolved_at) AS resolved_at FROM (
        SELECT order_delivery_id, resolved_at FROM message_attempt
         WHERE resolved_at IS NOT NULL AND status IN ('SUCCEEDED','FAILED_FINAL','UNKNOWN')
        UNION ALL
        SELECT order_delivery_id, resolved_at FROM pin_issue_command WHERE resolved_at IS NOT NULL
    ) t GROUP BY order_delivery_id
) ev ON ev.order_delivery_id = wf.order_delivery_id
WHERE wf.workflow_status IN
      ('FAILED_FINAL','OPS_REVIEW_REQUIRED','RESOLVED_MANUALLY_FAILED','RESOLVED_MANUALLY_REFUNDED')
GROUP BY wf.workflow_status;
```

⚠️ `날짜어긋남` 의 분모는 `행수` 가 아니다 — 재료가 없는 행은 `NULL` 비교라 `SUM` 에서 조용히 빠진다.

③ `OPS_REVIEW_REQUIRED` 를 이 목록에 계속 둘지(운영 확인).

---

## 3. 같은 구멍이 다른 파일에도 있다 (이 PR 범위 밖)

무효 datetime(제로날짜 등)은 `NULL` 이 아니라 **값**이라 `NOT NULL` 컬럼에도 들어갈 수 있고,
mysql2 는 그것을 `Invalid Date` 로 돌려준다. `x ? format(x) : null` 형태의 truthy 가드는
Invalid Date 를 통과시키고, `format()`(date-fns v3)이 `RangeError` 를 던진다.
`.map()` 안이면 **그 행 하나가 아니라 페이지 전체가 500** 이 된다.

PR #96 은 `partner_company_extern_history` 안의 5곳을 `pickListDate`/`formatListDate` 통로로 통일했다.
**같은 형태가 다른 파일에 남아 있다:**

| 파일:라인 | 표현식 | 비고 |
|---|---|---|
| `src/refund/application/refund.service.ts:111` | `format(orderDelivery.sendRequestAt, DateFormatStr)` | **truthy 가드조차 없다.** `.map()` 안 — 환불목록 페이지 전체가 죽는다 |
| `src/order_receive/application/order.receive.service.ts:803, :894` | 〃 | |
| `src/order/application/order.service.ts:7706` | 〃 | |
| `src/customer_service/application/customer.service.service.ts:949, :951` | 〃 | |
| `src/partner_company_extern/application/partner.company.extern.service.ts:1127` | `format(..., 'yyyyMMdd')` | **협력사 API 요청 조립부** — 여기서 던지면 발송 자체가 실패 |

한 PR 에서 6개 모듈을 건드리는 것이 더 위험해 이 PR 에서는 고치지 않았다.
확산할 때는 개별 인라인이 아니라 **공용 헬퍼**를 권한다 — 자연스러운 자리는
`src/common/domain/date.format.str.ts` 다(위 호출부들이 이미 `DateFormatStr` 를 여기서 import 한다).

### 확인 쿼리 (모드 무관)

```sql
SELECT COUNT(*) FROM order_delivery
WHERE YEAR(send_request_at) = 0 OR MONTH(send_request_at) = 0 OR DAY(send_request_at) = 0;
```

⚠️ `send_request_at = '0000-00-00 00:00:00'` 형태는 부분 제로날짜(`2026-00-00`)를 못 세고,
`sql_mode` 에 따라 리터럴 비교 자체가 무력화될 수도 있다.

---

## 4. 미결 — `invalidDateCount` 를 화면에 띄울지

PR #96 이 응답에 `invalidDateCount`(무효 날짜 도달 횟수)를 추가했다. 0 이면 정상이고,
0 이 아니면 그 컬럼을 채운 경로를 찾아야 한다는 신호다.

**현재 프론트는 이 값을 쓰지 않는다.** 같은 성격의 `mirrorMismatchCount` 는
`features/send/fail-history/index.tsx:386` 에서 0 이 아닐 때 배너로 띄운다.

| | 프론트 작업 | 누가 알아채나 |
|---|---|---|
| 현행 | 없음 | 로그(`[LIST_DATE_INVALID]`)를 보는 개발자만 |
| 배너 추가 | 몇 줄 | 운영자가 화면에서 바로 |

**판단**: 아직 그런 값이 실제로 있는지 확인되지 않았다. 배포 후 로그·응답에서 0 이 아닌 것이
관측되면 그때 프론트에 배너를 요청한다. 관측되지 않으면 배너는 영원히 안 뜨는 코드가 된다.

---

## 5. 미결 — 칸 순서 이중 정의 (리뷰 제안 "대안 A")

칸 순서가 `LIST_DATE_EXPR`(SQL)과 `legacyDisplayDate`(TS) **두 곳에 선언**돼 있다.
리뷰는 배열 하나로 단일 선언하고 양쪽을 거기서 생성하는 안을 제시했다.

**이 PR 에서 채택하지 않은 이유:**

- 칸마다 예외가 있다 — ①은 SQL 전용(CASE), SQL 은 문자열 조립·TS 는 값 접근이라 3-튜플이 필요하다.
  리뷰가 말한 ~25줄은 낙관적이고, 예외를 정직하게 표현하면 그보다 커진다.
- `LIST_DATE_EXPR` 이 리터럴이 아니게 되면 **SQL 을 눈으로 읽어 검증하는 능력**을 잃는다.
  돈·CS 경로라 그 가독성에 실제 가치가 있다.
- 전환 0건 + §1 의 축 결정이 미결인 상태에서 추상화를 굳히면 **잘못된 축을 구조로 고정**한다.

**남은 위험**: 칸 순서 테스트(`sot-view.spec.ts`)는 하드코딩 5칸의 **순서만** 본다.
새 칸을 **삽입**하면 못 잡는다. 새 칸을 넣을 때는 그 배열과 `legacyDisplayDate` 를 **둘 다** 손댈 것.

후속안으로 `getRawAndEntities()` 로 SQL 이 계산한 `sortDate` 를 표시에 재사용하는 방법도 제시됐다.
조인이 전부 ManyToOne 이고 `wf` 가 UNIQUE 라 팬아웃이 없어 안전하다(확인함). 단 두 조건이 붙는다:
- **인덱스 zip 금지** — `raw[i] ↔ entities[i]` 는 나중에 OneToMany 조인이 하나만 추가돼도 어긋난다.
  `raw['orderDelivery_id']` 로 맵 조인할 것.
- 그 안을 채택해도 **무효값 방어(`isValidDate`)는 남아야 한다.** SQL 이 돌려주는 `sortDate` 도
  부분 제로날짜면 Invalid Date 로 온다. 그 안은 **칸 순서** 이중 정의를 없애지 무효값 방어를 없애지 못한다.

---

## 6. 미확인 — MySQL 의 제로/부분제로 날짜 성분 함수

`LIST_DATE_EXPR` 의 `validDateSql` 은 `YEAR(col) > 0 AND MONTH(col) > 0 AND DAY(col) > 0` 를 쓴다.
**실 MySQL 로 검증하지 못했다**(운영 RDS 는 퍼블릭 액세스 off 라 로컬 직결 불가).

배포 전 개발 DB 에서 한 번 확인할 것:

```sql
SELECT YEAR('2026-00-00'), MONTH('2026-00-00'), DAY('2026-00-00');  -- 2026, 0, 0 이어야 한다
SELECT @@sql_mode;   -- NO_ZERO_DATE / NO_ZERO_IN_DATE 가 있으면 새 무효값은 안 들어온다
```

`@@sql_mode` 는 **필수 확인이 아니다.** 방어가 리터럴 비교가 아니라 값 성분 판정이라 모드에
의존하지 않는다. 다만 "앞으로 새로 들어올 수 있는가"를 아는 데는 쓸모가 있다.
