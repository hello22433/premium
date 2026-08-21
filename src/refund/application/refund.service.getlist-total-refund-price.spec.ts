import { InternalServerErrorException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { RefundService } from './refund.service';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { ActivityLogService } from '../../activity_log/application/activity.log.service';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { OrderDeliveryRefundStatusEnum } from '../../delivery/interface/order.delivery.refund.status.enum';

/**
 * 환불목록 상단 '총 환불금액'(totalRefundPrice).
 * ⚠️ 이 스펙은 repository mock 이라 SQL 의 **의미가 아니라 호출 형태**만 잠근다 — 집계식 문자열,
 * 필터를 다 적용한 뒤 clone, skip/take 이전 실행, 0건 처리, PII 로그 1회. 실제로 그 컬럼을 읽는지와
 * 행 합 일치는 DB 통합테스트 영역이다(같은 한계: refund.service.getlist-price-snapshot.spec).
 */

// 부분일치(toContain)로 두면 곱셈이 덧셈으로 바뀐 식도 통과하므로 전문을 대조한다.
const EXPECTED_SUM_EXPRESSION =
  'SUM(CAST(COALESCE(orderProductMapping.snapshotProductPrice, product.price, 0) * orderDelivery.refundRatio AS DECIMAL(20, 4)) / 100)';

const cipherStub = {
  safeDecryptDeliveryTarget: (v: string) => v,
  safeDecryptAccountNumber: (v: string) => v,
  encryptDeliveryTarget: (v: string) => `enc:${v}`,
} as unknown as CryptoCipher;

const auditContext = {
  user: {} as ILoginUserInfo,
  ipAddress: '127.0.0.1',
};

// rawRow 를 통째로 넘기면 alias 불일치(키 부재)·비정상 driver 값까지 재현할 수 있다.
function makeHarness(rawTotalRefundPrice: unknown, options: { rawRow?: unknown } = {}) {
  const rawRow = 'rawRow' in options ? options.rawRow : { totalRefundPrice: rawTotalRefundPrice };
  const callOrder: string[] = [];
  const aggregate: any = {
    select: jest.fn(() => aggregate),
    getRawOne: jest.fn().mockResolvedValue(rawRow),
  };

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
    qb[m] = jest.fn(() => {
      callOrder.push(m);
      return qb;
    });
  }
  qb.clone = jest.fn(() => {
    callOrder.push('clone');
    return aggregate;
  });
  qb.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);

  const createLog = jest.fn().mockResolvedValue(undefined);
  const service = new RefundService(
    cipherStub,
    { createLog } as unknown as ActivityLogService,
    { createQueryBuilder: jest.fn(() => qb) } as unknown as Repository<OrderDeliveryEntity>,
  );

  return { service, qb, aggregate, callOrder, createLog };
}

describe('RefundService.getList — 총 환불금액(totalRefundPrice)', () => {
  it('행 계산과 동일한 스냅샷 우선 규칙(COALESCE)으로 집계한다', async () => {
    const { service, aggregate } = makeHarness('3500.0000');

    const res = await service.getList({ page: 1, take: 10 } as any, auditContext);

    const [expression, alias] = aggregate.select.mock.calls[0];
    expect(expression).toBe(EXPECTED_SUM_EXPRESSION);
    expect(alias).toBe('totalRefundPrice');
    expect(res.totalRefundPrice).toBe(3500);
  });

  // where 가 실제로 복사되는지는 TypeORM 동작이라 여기서 못 잡는다 — clone 을 정확히 1회 뜨고
  // skip/take/orderBy 보다 앞선다는 '호출 위치'만 고정한다(모집단 일치 검증은 db-integration).
  it('clone 을 1회만 뜨고 skip/take/orderBy 적용 이전에 집계한다(페이지·정렬 무관)', async () => {
    const { service, qb, callOrder } = makeHarness('1000');

    await service.getList({ page: 2, take: 10 } as any, auditContext);

    expect(qb.clone).toHaveBeenCalledTimes(1);
    expect(callOrder.indexOf('clone')).toBeLessThan(callOrder.indexOf('skip'));
    expect(callOrder.indexOf('clone')).toBeLessThan(callOrder.indexOf('take'));
    // orderBy 가 clone 위로 올라가면 집계 쿼리에 비집계 ORDER BY 가 남아 ONLY_FULL_GROUP_BY 에서 목록 API 가 500 이 된다.
    expect(callOrder.indexOf('clone')).toBeLessThan(callOrder.indexOf('orderBy'));
  });

  // clone 위치가 필터 블록보다 위로 올라가면 합계가 '검색결과 합계'가 아니라 '전체 합계'가 된다.
  it('검색조건을 모두 적용한 뒤에 clone 한다 — 필터가 집계 모집단에 반영된다', async () => {
    const { service, callOrder } = makeHarness('1000');

    await service.getList(
      {
        page: 1,
        take: 10,
        startAt: '2026-08-01T00:00:00',
        endAt: '2026-08-14T23:59:59',
        userBusinessName: '고객사',
        userPersonName: '담당자',
        refundStatus: OrderDeliveryRefundStatusEnum.PROGRESS,
        deliveryTarget: '010-1234-5678',
      } as any,
      auditContext,
    );

    const andWhereIndexes = callOrder.flatMap((name, index) => (name === 'andWhere' ? [index] : []));
    expect(Math.max(...andWhereIndexes)).toBeLessThan(callOrder.indexOf('clone'));
  });

  it('매칭 0건(SUM 이 NULL)이면 0 을 반환한다', async () => {
    const { service } = makeHarness(null);

    const res = await service.getList({ page: 1, take: 10 } as any, auditContext);

    expect(res.totalRefundPrice).toBe(0);
  });

  // NULL 이 아닌데 숫자가 아니면 코드 결함이다. 0 원으로 응답하면 목록엔 행이 있는데 총합만 0 인 화면이
  // 아무 신호 없이 나가므로, 자금 화면에서는 실패가 낫다.
  it.each([
    ['alias 불일치로 키가 없음', {}],
    ['집계 행 자체가 없음', undefined],
    ['숫자로 파싱되지 않는 값', { totalRefundPrice: 'not-a-number' }],
  ])('집계 결과가 비정상이면 0 으로 숨기지 않고 실패한다 — %s', async (_label, rawRow) => {
    const { service } = makeHarness(null, { rawRow });

    await expect(service.getList({ page: 1, take: 10 } as any, auditContext)).rejects.toThrow(
      InternalServerErrorException,
    );
  });

  it('deliveryTarget 검색 시에도 PII 검색 로그는 1건만 기록된다(집계가 중복 기록하지 않는다)', async () => {
    const { service, createLog } = makeHarness('1000');

    await service.getList({ page: 1, take: 10, deliveryTarget: '010-1234-5678' } as any, auditContext);

    expect(createLog).toHaveBeenCalledTimes(1);
  });
});
