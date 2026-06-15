# 주문 라인 시점 박제(Order Line Snapshot) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 주문 라인 상품 정보(단가/이름/브랜드/유효기간/이미지)를 주문 시점에 박제해, 이후 문서(리포트·명세서·정산)가 LIVE 상품 변경에 오염되지 않게 한다.

**Architecture:** `order_product_mapping`에 nullable snapshot 컬럼 5개 추가. createTemp에서 LIVE product로 박제, updateTemp에서 mapping id 기준 승계. 문서 소비처(T2)는 중앙 helper `readLineProductView`로 snapshot 우선 읽기(레거시 NULL → LIVE fallback). 주문 상세 API는 가격 divergence 플래그 노출. legacy는 SQL backfill(단일라인 sendAmount 역산).

**Tech Stack:** NestJS, TypeORM 0.3, Jest, MySQL/MariaDB. 설계 근거: `docs/plans/2026-06-15-order-line-snapshot-design.md`

**범위:** 이번 PR = T2(문서) + 컬럼/박제/승계/divergence/backfill. T1(발송경로)·T3(CS표시)는 후속 PR.

---

## Task 0: Worktree 생성

프로젝트 CLAUDE.md 절차. 메인 repo에서:

```bash
cd "D:/workspace/2_Project/0_ePOPKON/epopkon-premium"
git checkout develop
git pull upstream develop
git worktree add .worktrees/wip1 -b feature/wip1
cd .worktrees/wip1
```

이후 모든 작업은 `.worktrees/wip1` 안에서. 경로는 worktree 기준 상대.

---

## Task 1: 엔티티 snapshot 컬럼 5개 추가

**Files:**
- Modify: `src/entity/order.product.mapping.entity.ts` (testDeliveryCount 컬럼 뒤, relation 앞 ~line 108)
- Create: `sql/20260615_add_order_product_mapping_snapshot.sql` (prod 적용용, 사용자 실행)

**Step 1: 엔티티 컬럼 추가**

`testDeliveryCount` 컬럼(108행) 다음에 삽입:

```typescript
  @Column({ type: 'int', nullable: true, comment: '[snapshot] 주문 시점 상품 단가' })
  snapshotProductPrice: number | null;

  @Column({ type: 'varchar', length: 255, nullable: true, comment: '[snapshot] 주문 시점 상품명' })
  snapshotProductName: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, comment: '[snapshot] 주문 시점 브랜드명' })
  snapshotProductBrandName: string | null;

  @Column({ type: 'int', nullable: true, comment: '[snapshot] 주문 시점 유효기간 일수' })
  snapshotProductExpireDay: number | null;

  @Column({ type: 'varchar', length: 500, nullable: true, comment: '[snapshot] 주문 시점 상품 이미지 경로' })
  snapshotProductImagePath: string | null;
```

**Step 2: SQL 마이그레이션 파일 작성** (prod synchronize=false 이므로 수동)

`sql/20260615_add_order_product_mapping_snapshot.sql`:

```sql
ALTER TABLE order_product_mapping
  ADD COLUMN snapshot_product_price INT NULL COMMENT '[snapshot] 주문 시점 상품 단가',
  ADD COLUMN snapshot_product_name VARCHAR(255) NULL COMMENT '[snapshot] 주문 시점 상품명',
  ADD COLUMN snapshot_product_brand_name VARCHAR(255) NULL COMMENT '[snapshot] 주문 시점 브랜드명',
  ADD COLUMN snapshot_product_expire_day INT NULL COMMENT '[snapshot] 주문 시점 유효기간 일수',
  ADD COLUMN snapshot_product_image_path VARCHAR(500) NULL COMMENT '[snapshot] 주문 시점 상품 이미지 경로';
```
(컬럼명은 naming strategy(snake_case)에 맞춤. 실제 전략 확인 후 조정.)

**Step 3: 빌드 확인** — 사용자에게 `npm run build` 요청. 컴파일 통과 확인.

**Step 4: Commit**

```bash
git add src/entity/order.product.mapping.entity.ts sql/20260615_add_order_product_mapping_snapshot.sql
git commit -m "feat: order_product_mapping 라인 snapshot 컬럼 5개 추가"
```

---

## Task 2: 라인 snapshot builder + reader helper (TDD)

**Files:**
- Modify: `src/order/util/order.snapshot.builder.ts`
- Create: `src/order/util/order.snapshot.builder.line.spec.ts`

**Step 1: 실패 테스트 작성**

`order.snapshot.builder.line.spec.ts`:

```typescript
import { buildLineProductSnapshot, readLineProductView } from './order.snapshot.builder';

const product = (over: any = {}) => ({
  id: 1, name: '상품A', price: 1000, expireDay: 30, imagePath: '/img/a.png',
  brand: { nameKorean: '브랜드A' }, ...over,
}) as any;

describe('buildLineProductSnapshot', () => {
  it('LIVE product에서 5필드 박제', () => {
    expect(buildLineProductSnapshot(product())).toEqual({
      snapshotProductPrice: 1000,
      snapshotProductName: '상품A',
      snapshotProductBrandName: '브랜드A',
      snapshotProductExpireDay: 30,
      snapshotProductImagePath: '/img/a.png',
    });
  });
  it('brand 없으면 브랜드명 빈문자', () => {
    expect(buildLineProductSnapshot(product({ brand: null })).snapshotProductBrandName).toBe('');
  });
});

describe('readLineProductView', () => {
  it('snapshot 있으면 snapshot 우선', () => {
    const opm = { snapshotProductPrice: 1000, snapshotProductName: '구상품', snapshotProductBrandName: '구브랜드',
      snapshotProductExpireDay: 30, snapshotProductImagePath: '/old.png',
      product: { name: '신상품', price: 1500, expireDay: 60, imagePath: '/new.png', brand: { nameKorean: '신브랜드' } } } as any;
    expect(readLineProductView(opm)).toEqual({
      name: '구상품', price: 1000, brandName: '구브랜드', expireDay: 30, imagePath: '/old.png',
    });
  });
  it('legacy snapshot NULL이면 LIVE fallback', () => {
    const opm = { snapshotProductPrice: null, snapshotProductName: null, snapshotProductBrandName: null,
      snapshotProductExpireDay: null, snapshotProductImagePath: null,
      product: { name: '신상품', price: 1500, expireDay: 60, imagePath: '/new.png', brand: { nameKorean: '신브랜드' } } } as any;
    expect(readLineProductView(opm)).toEqual({
      name: '신상품', price: 1500, brandName: '신브랜드', expireDay: 60, imagePath: '/new.png',
    });
  });
  it('삭제상품(product null)이면 안전 기본값', () => {
    const opm = { snapshotProductPrice: null, snapshotProductName: null, snapshotProductBrandName: null,
      snapshotProductExpireDay: null, snapshotProductImagePath: null, product: null } as any;
    expect(readLineProductView(opm)).toEqual({
      name: '(삭제된 상품)', price: 0, brandName: '', expireDay: 0, imagePath: null,
    });
  });
});
```

**Step 2: 실패 확인** — `npx jest order.snapshot.builder.line -v` → FAIL (함수 없음)

**Step 3: 구현** — `order.snapshot.builder.ts` 하단에 추가:

```typescript
import { ProductEntity } from '../../entity/product.entity';
import { OrderProductMappingEntity } from '../../entity/order.product.mapping.entity';

type LineProductSnapshotPart = Pick<
  OrderProductMappingEntity,
  'snapshotProductPrice' | 'snapshotProductName' | 'snapshotProductBrandName'
  | 'snapshotProductExpireDay' | 'snapshotProductImagePath'
>;

// 주문 시점 상품 정보 박제. product.brand가 로드된 ProductEntity를 넘겨야 함.
export function buildLineProductSnapshot(product: ProductEntity): LineProductSnapshotPart {
  return {
    snapshotProductPrice: product.price ?? null,
    snapshotProductName: product.name ?? null,
    snapshotProductBrandName: product.brand?.nameKorean ?? '',
    snapshotProductExpireDay: product.expireDay ?? null,
    snapshotProductImagePath: product.imagePath ?? null,
  };
}

export type LineProductView = {
  name: string;
  price: number;
  brandName: string;
  expireDay: number;
  imagePath: string | null;
};

// 조회 시 snapshot 우선, NULL이면 LIVE product fallback (readBillingView와 동일 패턴).
export function readLineProductView(opm: OrderProductMappingEntity): LineProductView {
  return {
    name: opm.snapshotProductName ?? opm.product?.name ?? '(삭제된 상품)',
    price: opm.snapshotProductPrice ?? opm.product?.price ?? 0,
    brandName: opm.snapshotProductBrandName ?? opm.product?.brand?.nameKorean ?? '',
    expireDay: opm.snapshotProductExpireDay ?? opm.product?.expireDay ?? 0,
    imagePath: opm.snapshotProductImagePath ?? opm.product?.imagePath ?? null,
  };
}
```

**Step 4: 통과 확인** — `npx jest order.snapshot.builder.line -v` → PASS

**Step 5: Commit**

```bash
git add src/order/util/order.snapshot.builder.ts src/order/util/order.snapshot.builder.line.spec.ts
git commit -m "feat: 라인 상품 snapshot builder/reader helper 추가"
```

---

## Task 3: createTemp 박제 + brand relation 로드

**Files:**
- Modify: `src/order/application/order.service.ts` (createTemp 상품 조회 + OPM 저장부)

**Step 1: 상품 조회에 brand relation 추가**

createTemp의 `productRepository.find({ where: { id: In(...) } })` 호출에 `relations: ['brand']` 추가 (브랜드명 박제 필수). 정확 위치는 createTemp 내부 productList 조회 지점 — `grep -n "productRepository.find" src/order/application/order.service.ts`로 확인.

**Step 2: OPM 저장 시 박제 적용**

createTemp에서 `new OrderProductMappingEntity()` 채우는 루프에 추가:

```typescript
const liveProduct = productPriceMap.get(product.productId)!;
Object.assign(orderProduct, buildLineProductSnapshot(liveProduct));
```
(import: `buildLineProductSnapshot` from `../util/order.snapshot.builder`)

**Step 3: 빌드 확인** — 사용자 `npm run build` 요청.

**Step 4: Commit**

```bash
git add src/order/application/order.service.ts
git commit -m "feat: createTemp 주문 생성 시 라인 상품 snapshot 박제"
```

---

## Task 4: updateTemp mapping id 기준 승계 (TDD)

**Files:**
- Modify: `src/order/application/order.service.ts` (`updateTemp` 3044~)
- Create: `src/order/application/order.service.update-temp-snapshot.spec.ts`

**핵심 계약** (design Section 2):
- 트랜잭션 순서: 조회 → 검증 → 삭제 → 재생성
- 삭제 전 `Map<oldMappingId, { productId, snapshot }>` 적재
- `line.id` 전달 + 주문 비소유(map 멤버 아님) → 400
- 요청 내 `line.id` 중복 → 400
- `line.id` 有 + 동일 productId → snapshot 값 승계
- `line.id` 有 + productId 변경 / `line.id` 無 → LIVE 신규 박제
- 상품 조회 `relations: ['brand']`

**Step 1: 실패 테스트** — `order.service.update-temp-snapshot.spec.ts`. 순수 로직(승계 결정 함수)을 추출해 단위 테스트하는 것을 권장. `resolveLineSnapshot(line, ownedMap, liveProduct)` 헬퍼를 updateTemp에서 분리:

```typescript
import { resolveLineSnapshot, assertLineIdsValid } from './order.snapshot.update.helper';

describe('assertLineIdsValid', () => {
  const owned = new Map([[10, { productId: 1 }], [11, { productId: 2 }]]);
  it('타 주문 id면 400', () => {
    expect(() => assertLineIdsValid([{ id: 99, productId: 1 }] as any, owned)).toThrow();
  });
  it('요청 내 중복 id면 400', () => {
    expect(() => assertLineIdsValid([{ id: 10, productId: 1 }, { id: 10, productId: 1 }] as any, owned)).toThrow();
  });
  it('정상이면 통과', () => {
    expect(() => assertLineIdsValid([{ id: 10, productId: 1 }, { productId: 3 }] as any, owned)).not.toThrow();
  });
});

describe('resolveLineSnapshot', () => {
  const snapA = { snapshotProductPrice: 1000, snapshotProductName: 'A', snapshotProductBrandName: 'bA',
    snapshotProductExpireDay: 30, snapshotProductImagePath: '/a.png' };
  const owned = new Map([[10, { productId: 1, snapshot: snapA }]]);
  const live = { price: 1500, name: 'A2', brand: { nameKorean: 'bA2' }, expireDay: 60, imagePath: '/a2.png' } as any;
  it('동일 id+productId → 기존 snapshot 승계', () => {
    expect(resolveLineSnapshot({ id: 10, productId: 1 } as any, owned, live)).toEqual(snapA);
  });
  it('id 있으나 productId 교체 → LIVE 신규 박제', () => {
    expect(resolveLineSnapshot({ id: 10, productId: 1 } as any, owned, live).snapshotProductPrice).toBe(1000); // 동일 productId
    const swapped = resolveLineSnapshot({ id: 10, productId: 9 } as any, owned, live);
    expect(swapped.snapshotProductPrice).toBe(1500);
  });
  it('id 없음(신규행) → LIVE 신규 박제', () => {
    expect(resolveLineSnapshot({ productId: 1 } as any, owned, live).snapshotProductPrice).toBe(1500);
  });
});
```

**Step 2: 실패 확인** — `npx jest order.service.update-temp-snapshot -v` → FAIL

**Step 3: 구현** — `src/order/application/order.snapshot.update.helper.ts` 생성:

```typescript
import { BadRequestException } from '@nestjs/common';
import { ProductEntity } from '../../entity/product.entity';
import { buildLineProductSnapshot } from '../util/order.snapshot.builder';

export type OwnedLine = { productId: number; snapshot?: any };

export function assertLineIdsValid(
  lines: { id?: number; productId: number }[],
  owned: Map<number, OwnedLine>,
): void {
  const seen = new Set<number>();
  for (const line of lines) {
    if (line.id == null) continue;
    if (!owned.has(line.id)) {
      throw new BadRequestException('해당 주문에 속하지 않는 상품 행입니다.');
    }
    if (seen.has(line.id)) {
      throw new BadRequestException('동일 상품 행 ID가 중복 전달되었습니다.');
    }
    seen.add(line.id);
  }
}

export function resolveLineSnapshot(
  line: { id?: number; productId: number },
  owned: Map<number, OwnedLine>,
  liveProduct: ProductEntity,
) {
  if (line.id != null) {
    const prev = owned.get(line.id);
    if (prev && prev.productId === line.productId && prev.snapshot) {
      return prev.snapshot; // 동일 상품 → 기존 snapshot 값 승계
    }
  }
  return buildLineProductSnapshot(liveProduct); // 신규행/상품교체 → LIVE 박제
}
```

`updateTemp` 본문 수정 (3089~3176 구간):
1. 상품 조회 `relations: ['brand']` 추가.
2. 삭제(3126) 전, 적재 + 검증:
```typescript
const existingMappings = await this.orderProductMappingRepository.find({ where: { orderId } });
const ownedMap = new Map<number, OwnedLine>(
  existingMappings.map((m) => [m.id, {
    productId: m.productId,
    snapshot: {
      snapshotProductPrice: m.snapshotProductPrice,
      snapshotProductName: m.snapshotProductName,
      snapshotProductBrandName: m.snapshotProductBrandName,
      snapshotProductExpireDay: m.snapshotProductExpireDay,
      snapshotProductImagePath: m.snapshotProductImagePath,
    },
  }]),
);
assertLineIdsValid(orderProductList, ownedMap);
```
   (기존 `deleteOrderProductMappingList` 조회를 이 `existingMappings`로 재사용.)
3. 재생성 루프(3140~)에서 각 행:
```typescript
const liveProduct = productPriceMap.get(product.productId)!;
Object.assign(orderProduct, resolveLineSnapshot(product, ownedMap, liveProduct));
```
   ※ legacy 승계 시 snapshot이 전부 NULL이면 그대로 NULL 승계(이 단계서 재박제 안 함 — design 계약). Task 7 backfill 담당.

**Step 4: 통과 확인** — `npx jest order.service.update-temp-snapshot -v` → PASS

**Step 5: 빌드 확인** — 사용자 `npm run build`.

**Step 6: Commit**

```bash
git add src/order/application/order.snapshot.update.helper.ts src/order/application/order.service.update-temp-snapshot.spec.ts src/order/application/order.service.ts
git commit -m "feat: updateTemp 라인 snapshot mapping id 기준 승계 + 소유권/중복 검증"
```

---

## Task 5: T2 문서 소비처 snapshot 전환 (TDD)

**Files:**
- Modify: `src/order/application/order.service.ts` — `getDeliveryCompleteReport`(1288), `getOrderCompleteReport`(1511), `getDeliveryCompleteReportMultiple`(1685), `getOrderCompleteReportMultiple`(1889), `getOrderSettle`(2025)
- Modify: `src/settle/application/settle.service.ts` — `getUserDetail`(1596), `getUserPerDetail`(2220), multiple 변형(1697)
- Create: `src/order/application/order.service.report-snapshot.spec.ts` (통합 성격 단위)

**원칙:** 각 빌더에서 `orderProductMapping.product.price/name/brand/expireDay/imagePath` raw 접근을 `readLineProductView(opm)` 결과로 치환. 단가 계산(`originalPrice`) 시작점도 view.price 사용. **이 빌더들이 opm.product를 로드하는 쿼리에 `product.brand`가 leftJoin 되어 있는지 확인** (대부분 이미 join — Section 3 grep 결과 참조). 누락 시 추가.

**Step 1: 실패 테스트** — 상품가 변경 시 명세서가 snapshot 단가를 쓰는지:

```typescript
// getOrderCompleteReport 핵심: originalPrice가 snapshotProductPrice를 따름
it('상품 LIVE 가격이 바뀌어도 명세서는 snapshot 단가 사용', async () => {
  // opm: snapshotProductPrice=1000, product.price=1500, amount=2, fee=null
  // 기대 unitPrice=1000, price(공급가)=2000
});
```
(실제로는 서비스 메서드를 mock repository로 호출하거나, 계산 로직만 분리해 검증. 기존 spec 패턴 따름.)

**Step 2: 실패 확인** → FAIL (현재 LIVE 1500 사용)

**Step 3: 구현** — 각 빌더 치환. 예 `getOrderCompleteReport` 1548:
```typescript
const view = readLineProductView(orderProductMapping);
const originalPrice = view.price;
// ... productName: view.name, 등
```
`getDeliveryCompleteReport` 1369-1387: `productName/amount/price/name/brandName/imagePath/expireDay` 전부 view 기반.
정산(`settle.service.ts` 1621/1623/1750/1752): `originalPrice = readLineProductView(mapping).price`.

**Step 4: 통과 확인** → PASS

**Step 5: 빌드 확인** — 사용자 `npm run build`.

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: 리포트/명세서/정산 문서가 라인 snapshot 단가·정보 사용(T2)"
```

---

## Task 6: 주문 상세 API divergence 플래그 (TDD)

**Files:**
- Modify: 주문 상세 빌더 (`getDetail` 류 — `grep -n "getDetail" src/order/application/order.service.ts`) + 응답 DTO `src/order/api/dto/order.detail.product.dto.ts`
- Create: `src/order/application/order.service.price-divergence.spec.ts`

**Step 1: 실패 테스트**

```typescript
import { buildPriceDivergence } from '../util/order.snapshot.builder';
describe('buildPriceDivergence', () => {
  it('snapshot≠현재가 → changed true', () => {
    expect(buildPriceDivergence({ snapshotProductPrice: 1000, product: { price: 1500 } } as any))
      .toEqual({ priceChanged: true, snapshotPrice: 1000, currentPrice: 1500 });
  });
  it('동일가 → changed false', () => {
    expect(buildPriceDivergence({ snapshotProductPrice: 1500, product: { price: 1500 } } as any))
      .toEqual({ priceChanged: false, snapshotPrice: 1500, currentPrice: 1500 });
  });
  it('legacy snapshot NULL → changed false', () => {
    expect(buildPriceDivergence({ snapshotProductPrice: null, product: { price: 1500 } } as any))
      .toEqual({ priceChanged: false, snapshotPrice: null, currentPrice: 1500 });
  });
  it('삭제상품 → currentPrice null, changed false', () => {
    expect(buildPriceDivergence({ snapshotProductPrice: 1000, product: null } as any))
      .toEqual({ priceChanged: false, snapshotPrice: 1000, currentPrice: null });
  });
});
```

**Step 2: 실패 확인** → FAIL

**Step 3: 구현** — builder에 추가:
```typescript
export function buildPriceDivergence(opm: OrderProductMappingEntity) {
  const snapshotPrice = opm.snapshotProductPrice ?? null;
  const currentPrice = opm.product?.price ?? null;
  const priceChanged = snapshotPrice != null && currentPrice != null && snapshotPrice !== currentPrice;
  return { priceChanged, snapshotPrice, currentPrice };
}
```
주문 상세 응답 라인에 spread. DTO에 `priceChanged: boolean`, `snapshotPrice: number|null`, `currentPrice: number|null` 필드 추가.

**Step 4: 통과 확인** → PASS

**Step 5: 빌드 확인** + **Commit**

```bash
git add -A
git commit -m "feat: 주문 상세에 라인 가격 divergence 플래그 노출"
```

---

## Task 7: Legacy backfill SQL + 역산불가 식별

**Files:**
- Create: `sql/20260615_backfill_order_product_mapping_snapshot.sql`
- Create: `sql/20260615_report_unreconstructable_lines.sql`

**Step 1: 표시필드 backfill** (name/brand/expire/image — LIVE best-effort):

```sql
UPDATE order_product_mapping opm
JOIN product p ON p.id = opm.product_id
LEFT JOIN brand b ON b.id = p.brand_id
SET opm.snapshot_product_name = COALESCE(opm.snapshot_product_name, p.name),
    opm.snapshot_product_brand_name = COALESCE(opm.snapshot_product_brand_name, b.name_korean),
    opm.snapshot_product_expire_day = COALESCE(opm.snapshot_product_expire_day, p.expire_day),
    opm.snapshot_product_image_path = COALESCE(opm.snapshot_product_image_path, p.image_path)
WHERE opm.snapshot_product_name IS NULL;
```
(컬럼명·brand 컬럼명 실제 스키마 확인 후 조정.)

**Step 2: 단일라인 가격 역산 backfill** — 주문이 OPM 1행 + amount>0 + 나눠떨어짐:

```sql
UPDATE order_product_mapping opm
JOIN (
  SELECT o.id AS order_id, o.send_amount, m.amount
  FROM `order` o
  JOIN order_product_mapping m ON m.order_id = o.id
  GROUP BY o.id
  HAVING COUNT(m.id) = 1
) single ON single.order_id = opm.order_id
SET opm.snapshot_product_price = single.send_amount / single.amount
WHERE opm.snapshot_product_price IS NULL
  AND single.amount > 0
  AND single.send_amount MOD single.amount = 0;
```

**Step 3: 다중라인 등 나머지 가격 → LIVE fallback backfill:**

```sql
UPDATE order_product_mapping opm
JOIN product p ON p.id = opm.product_id
SET opm.snapshot_product_price = p.price
WHERE opm.snapshot_product_price IS NULL;
```

**Step 4: 역산 불가(LIVE로 채워진) 행 식별 리포트** — Step3 실행 *전*에 SELECT로 카운트/목록 남기기:

```sql
-- 단일라인 역산 대상이 아닌, 가격 snapshot이 비어있던 행 (= LIVE fallback 예정)
SELECT opm.order_id, opm.id AS mapping_id, opm.product_id, opm.amount, o.send_amount,
       (SELECT COUNT(*) FROM order_product_mapping m2 WHERE m2.order_id = opm.order_id) AS line_count
FROM order_product_mapping opm
JOIN `order` o ON o.id = opm.order_id
WHERE opm.snapshot_product_price IS NULL;  -- Step2 후 Step3 전 실행
```

**Step 5: Commit** (SQL은 사용자가 dev→prod 순 실행; 코드 커밋만)

```bash
git add sql/20260615_backfill_order_product_mapping_snapshot.sql sql/20260615_report_unreconstructable_lines.sql
git commit -m "chore: 라인 snapshot legacy backfill SQL + 역산불가 식별 쿼리"
```

---

## Task 8: 프론트 spec 문서 (forFront)

**Files:**
- Create: `D:/workspace/2_Project/0_ePOPKON/forFront/order-line-price-divergence-banner.md`

내용: 주문 상세 응답 라인의 `priceChanged/snapshotPrice/currentPrice` 사용법, 자사 운영자 화면에서 `priceChanged=true` 라인에 경고 배너/뱃지 표기, 문구 예시("주문 시점 단가 {snapshotPrice}원 → 현재 협력사 단가 {currentPrice}원. 문서는 주문시점 단가로 발행됩니다."). 프론트 repo 직접수정 금지 — spec만.

**Commit** (forFront는 루트 git repo 아님 → 별도 관리. 커밋 대상 아니면 생략).

---

## Task 9: 마무리 — 빌드 + simplify + 브랜치 정리

**Step 1:** 사용자에게 최종 `npm run build` + `npm test` 요청. 전체 통과 확인.

**Step 2:** `/simplify` 실행 — 수정 코드 품질 정리. 이후 빌드 재확인.

**Step 3:** 브랜치명 변경 + push (사용자 컨펌 후):

```bash
git branch -m feature/wip1 feature/order-line-snapshot
git push origin feature/order-line-snapshot
```

**Step 4:** worktree 정리:

```bash
cd "D:/workspace/2_Project/0_ePOPKON/epopkon-premium"
git worktree remove .worktrees/wip1
```

PR: base `upstream/develop` ← compare `origin/feature/order-line-snapshot` (웹에서 생성).

---

## 검증 체크리스트 (완료 전)

- [ ] 엔티티 컬럼 + SQL 마이그레이션 일치
- [ ] `readLineProductView` fallback 매트릭스 PASS
- [ ] createTemp 5필드 박제 (brand relation 로드 확인)
- [ ] updateTemp 승계/검증 단위 PASS (소유권 400, 중복 400, 동일상품 승계, 상품교체 재박제)
- [ ] T2 문서가 snapshot 단가 사용 (LIVE 변경 후 불변 통합 확인)
- [ ] divergence 플래그 정확
- [ ] backfill SQL dev 검증 + 역산불가 리포트 확인
- [ ] 전체 빌드 + 테스트 통과
