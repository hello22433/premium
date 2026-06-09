import { DeliveryBatchService } from './delivery.batch.service';
import { IOrderDeliveryStatus } from '../interface/order.delivery.status';

/**
 * releaseStaleBatchClaims 단위 테스트.
 *
 * DeliveryBatchService 생성자 의존성이 많아, Object.create 로 프로토타입만 끌어오고
 * 메서드가 실제로 쓰는 orderDeliveryRepository 만 주입해 격리 검증한다.
 *
 * 검증:
 *  - 해제 범위 = status = WAIT (FAIL/FAIL_SMS 미포함) + claimedAt IS NOT NULL
 *  - set 은 claimedAt: null 만 (status/resendAt 불변)
 */
describe('DeliveryBatchService.releaseStaleBatchClaims', () => {
  let qb: any;
  let sut: DeliveryBatchService;

  beforeEach(() => {
    qb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 2 }),
    };
    sut = Object.create(DeliveryBatchService.prototype);
    (sut as any).orderDeliveryRepository = { createQueryBuilder: jest.fn(() => qb) };
  });

  it('status=WAIT + claimedAt IS NOT NULL 범위, claimedAt 만 null (status/resendAt 불변)', async () => {
    const released = await sut.releaseStaleBatchClaims();

    expect(released).toBe(2);
    // 대상 범위: status = WAIT (FAIL/FAIL_SMS 미포함)
    const statusWhere = qb.where.mock.calls.find((c: any[]) => /status = :status/.test(c[0]));
    expect(statusWhere).toBeDefined();
    expect(statusWhere![1].status).toBe(IOrderDeliveryStatus.WAIT);
    expect(statusWhere![1].status).not.toBe(IOrderDeliveryStatus.FAIL);
    expect(statusWhere![1].status).not.toBe(IOrderDeliveryStatus.FAIL_SMS);
    // claimedAt IS NOT NULL 조건
    expect(qb.andWhere.mock.calls.some((c: any[]) => /claimedAt IS NOT NULL/.test(c[0]))).toBe(true);
    // 상태 불변: set 은 claimedAt:null 만
    const setArg = qb.set.mock.calls[qb.set.mock.calls.length - 1][0];
    expect(setArg).toEqual({ claimedAt: null });
    expect(setArg).not.toHaveProperty('status');
    expect(setArg).not.toHaveProperty('resendAt');
  });

  it('affected 가 undefined 면 0 을 반환한다', async () => {
    qb.execute.mockResolvedValueOnce({});
    const released = await sut.releaseStaleBatchClaims();
    expect(released).toBe(0);
  });
});
