import { Repository } from 'typeorm';
import { RefundService } from './refund.service';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { ActivityLogService } from '../../activity_log/application/activity.log.service';
import { ILoginUserInfo } from '../../auth/interface/login.user';

/**
 * D3-69: 환불목록 deliveryPrice/refundPrice 단가 회귀.
 * getRefundList 가 과거엔 live product.price(가변)를 읽어, 주문 후 상품가가 바뀌면
 * 환불예정액이 손님 실납부액과 달라졌다. 라인 박제값(snapshotProductPrice ?? product.price)으로
 * 통일한 것을 잠근다.
 */

const cipherStub = {
  safeDecryptDeliveryTarget: (v: string) => v,
  safeDecryptAccountNumber: (v: string) => v,
} as unknown as CryptoCipher;

const auditContext = {
  user: {} as ILoginUserInfo,
  ipAddress: '127.0.0.1',
};

function makeOrderDelivery(over: {
  snapshotProductPrice: number | null;
  productPrice: number;
  refundRatio: number;
  snapshotProductName?: string | null; // 주문시점 상품명. 미지정 시 없음(레거시 행)
  productName?: string; // 현재 카탈로그 상품명(가변)
}) {
  return {
    id: 1,
    refundRegisterAt: new Date('2026-07-29T00:00:00.000Z'),
    sendRequestAt: new Date('2026-07-01T00:00:00.000Z'),
    personalCode: null,
    deliveryTarget: 'enc',
    bankAccount: null,
    bankAccountOwner: null,
    bankName: null,
    approveAt: null,
    refundStatus: null,
    refundAt: null,
    refundRatio: over.refundRatio,
    orderProductMapping: {
      snapshotProductPrice: over.snapshotProductPrice,
      snapshotProductName: over.snapshotProductName,
      product: { name: over.productName ?? '상품A', price: over.productPrice },
      order: { user: { company: { businessName: '고객사A' } } },
    },
  } as unknown as OrderDeliveryEntity;
}

/**
 * ⚠️ 커버리지 한계(리뷰 LOW, 의도적으로 명시):
 * 이 mock 은 조인/컬럼 선택 인자를 assert 하지 않는다. 따라서 누군가 실제 쿼리에 `.select([...])` 로
 * 컬럼을 제한해 `snapshotProductPrice`/`snapshotProductName` 이 로드되지 않게 되어도 이 스펙은 통과한다
 * (mock 이 이미 값이 담긴 엔티티를 그대로 돌려주므로). 그 회귀는 유닛 목으로는 잡히지 않으며
 * 통합/DB 테스트 영역이다. "이 스펙이 통과한다 = 스냅샷 컬럼이 실제로 로드된다" 로 읽지 말 것.
 */
function makeQueryBuilder(rows: OrderDeliveryEntity[]) {
  const qb: any = {};
  for (const m of [
    'innerJoinAndSelect',
    'leftJoinAndSelect',
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'skip',
    'take',
  ]) {
    qb[m] = jest.fn(() => qb);
  }
  qb.getManyAndCount = jest.fn().mockResolvedValue([rows, rows.length]);
  return qb;
}

function makeService(rows: OrderDeliveryEntity[]) {
  const repo = { createQueryBuilder: jest.fn(() => makeQueryBuilder(rows)) };
  return new RefundService(cipherStub, {} as ActivityLogService, repo as unknown as Repository<OrderDeliveryEntity>);
}

describe('RefundService.getList — 단가는 주문시점 박제값(snapshot)을 반환', () => {
  it('상품가 변경(snapshot=2000 ≠ live product.price=5000)이어도 deliveryPrice=2000, refundPrice 도 그 기준', async () => {
    const orderDelivery = makeOrderDelivery({ snapshotProductPrice: 2000, productPrice: 5000, refundRatio: 50 });
    const service = makeService([orderDelivery]);

    const res = await service.getList({ page: 1, take: 10 } as any, auditContext);

    expect(res.list[0].deliveryPrice).toBe(2000); // 영수증(박제)
    expect(res.list[0].deliveryPrice).not.toBe(5000); // 매대 가격표(live)를 따라가지 않는다
    expect(res.list[0].refundPrice).toBe(1000); // 2000 * 50% = 1000 (live 5000 기준이면 2500이 됐을 것)
  });

  it('레거시 행(snapshotProductPrice=null)은 live product.price 로 폴백한다', async () => {
    const orderDelivery = makeOrderDelivery({ snapshotProductPrice: null, productPrice: 3000, refundRatio: 100 });
    const service = makeService([orderDelivery]);

    const res = await service.getList({ page: 1, take: 10 } as any, auditContext);

    expect(res.list[0].deliveryPrice).toBe(3000);
    expect(res.list[0].refundPrice).toBe(3000);
  });

  // 리뷰 MEDIUM: 가격만 박제하고 상품명을 live 로 두면 "새 상품명 + 옛 가격" 이 한 행에 섞여
  // 담당자가 금액 오류로 오인할 수 있다 → 이름/가격이 같은 기준(주문시점)인지 잠근다.
  it('상품명도 주문시점 박제값을 쓴다 — 이름/가격이 같은 기준(한 행 내 혼재 없음)', async () => {
    const orderDelivery = makeOrderDelivery({
      snapshotProductPrice: 2000,
      productPrice: 5000,
      snapshotProductName: '주문당시 상품명',
      productName: '변경된 상품명',
      refundRatio: 50,
    });
    const service = makeService([orderDelivery]);

    const res = await service.getList({ page: 1, take: 10 } as any, auditContext);

    expect(res.list[0].productName).toBe('주문당시 상품명');
    expect(res.list[0].productName).not.toBe('변경된 상품명'); // live 를 따라가지 않는다
    expect(res.list[0].deliveryPrice).toBe(2000); // 이름과 같은 기준
  });

  it('레거시 행(snapshotProductName=null)은 live 상품명으로 폴백한다', async () => {
    const orderDelivery = makeOrderDelivery({
      snapshotProductPrice: null,
      productPrice: 3000,
      snapshotProductName: null,
      productName: '현재 상품명',
      refundRatio: 100,
    });
    const service = makeService([orderDelivery]);

    const res = await service.getList({ page: 1, take: 10 } as any, auditContext);

    expect(res.list[0].productName).toBe('현재 상품명');
  });
});
