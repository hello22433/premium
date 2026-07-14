import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { CustomerServiceService } from './customer.service.service';
import { IProductType } from '../../product/interface/product.type';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';

/**
 * getCouponViewLog 의 CS 권한 차단 / 단일 aggregate 집계 / 최신순 목록 검증.
 * 생성자 우회(Object.create) 후 협력자만 mock 주입한다.
 */
describe('CustomerServiceService — getCouponViewLog', () => {
  let service: any;
  let authorityValidator: jest.Mock;
  let getRawOne: jest.Mock;
  let find: jest.Mock;
  const user = { id: 1 } as any;

  const mockOrderDelivery = (productType?: IProductType) => {
    service.orderDeliveryRepository = {
      createQueryBuilder: jest.fn().mockReturnValue({
        innerJoinAndSelect: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        withDeleted: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest
          .fn()
          .mockResolvedValue(
            productType === undefined ? null : { id: 10, orderProductMapping: { product: { type: productType } } },
          ),
      }),
    };
  };

  beforeEach(() => {
    authorityValidator = jest.fn().mockResolvedValue(undefined);
    getRawOne = jest
      .fn()
      .mockResolvedValue({ total: '0', botCount: '0', firstHumanVisitedAt: null, lastVisitedAt: null });
    find = jest.fn().mockResolvedValue([]);
    service = Object.create(CustomerServiceService.prototype);
    service.authService = { authorityValidator };
    service.couponViewLogRepository = {
      createQueryBuilder: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawOne,
      }),
      find,
    };
    service.logger = { error: jest.fn(), log: jest.fn(), warn: jest.fn() };
  });

  it('존재하지 않는 발송건은 BadRequest 로 거부한다', async () => {
    mockOrderDelivery(undefined);
    await expect(service.getCouponViewLog(user, 999)).rejects.toBeInstanceOf(BadRequestException);
    expect(authorityValidator).not.toHaveBeenCalled();
  });

  it('CS 대상이 아닌 상품 유형은 BadRequest 로 거부한다', async () => {
    mockOrderDelivery(IProductType.DELIVERY);
    await expect(service.getCouponViewLog(user, 10)).rejects.toBeInstanceOf(BadRequestException);
    expect(authorityValidator).not.toHaveBeenCalled();
  });

  it('SSG 발송건은 CUSTOMER_SSG_COUPON 권한을 검증하고, 권한 없으면 차단한다', async () => {
    mockOrderDelivery(IProductType.SSG);
    authorityValidator.mockRejectedValue(new ForbiddenException());

    await expect(service.getCouponViewLog(user, 10)).rejects.toBeInstanceOf(ForbiddenException);
    expect(authorityValidator).toHaveBeenCalledWith(user, UserAuthSubEnum.CUSTOMER_SSG_COUPON);
    // 권한 실패 시 로그 조회로 넘어가지 않는다.
    expect(find).not.toHaveBeenCalled();
  });

  it('권한 통과 시 단일 aggregate 집계 + 최신순 목록을 반환한다', async () => {
    mockOrderDelivery(IProductType.GENERAL);

    const newer = {
      createdAt: new Date('2026-07-02T14:03:11'),
      ipAddress: '1.1.1.1',
      userAgent: 'a',
      source: 'alimtalk',
      isBot: false,
    };
    const older = {
      createdAt: new Date('2026-07-02T14:00:00'),
      ipAddress: '2.2.2.2',
      userAgent: 'b',
      source: 'alimtalk',
      isBot: true,
    };
    getRawOne.mockResolvedValue({
      total: '2',
      botCount: '1',
      firstHumanVisitedAt: new Date('2026-07-02T14:03:11'),
      lastVisitedAt: new Date('2026-07-02T14:03:11'),
    });
    find.mockResolvedValue([newer, older]);

    const res = await service.getCouponViewLog(user, 10);

    expect(authorityValidator).toHaveBeenCalledWith(user, UserAuthSubEnum.CUSTOMER_GENERAL_COUPON);
    // 응답 크기 상한 + 최신순 정렬로 목록 조회
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orderDeliveryId: 10 }, order: { createdAt: 'DESC' }, take: 100 }),
    );
    expect(res.total).toBe(2);
    expect(res.botCount).toBe(1);
    expect(res.humanCount).toBe(1); // total - botCount, 단일 쿼리라 항상 일관(음수 불가)
    expect(res.firstHumanVisitedAt).not.toBeNull();
    // items 는 조회 순서(최신순) 보존
    expect(res.items.map((i: any) => i.ipAddress)).toEqual(['1.1.1.1', '2.2.2.2']);
    expect(res.items[0].isBot).toBe(false);
    expect(res.items[1].isBot).toBe(true);
  });

  it('방문 기록이 없으면 빈 목록 + null 요약을 반환한다', async () => {
    mockOrderDelivery(IProductType.GENERAL);
    const res = await service.getCouponViewLog(user, 10);

    expect(res.total).toBe(0);
    expect(res.humanCount).toBe(0);
    expect(res.items).toEqual([]);
    expect(res.firstHumanVisitedAt).toBeNull();
    expect(res.lastVisitedAt).toBeNull();
  });
});
