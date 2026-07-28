import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { CustomerServiceService } from './customer.service.service';
import { IProductType } from '../../product/interface/product.type';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';

/**
 * HIGH 회귀 잠금 — /customer-service/unmasked-delivery-target 권한검사.
 * 클래스 로그인 가드만으로 복호화된 수신정보(개인정보)가 노출되던 결함 수정 검증.
 * 쿠폰 종류(product.type)에 맞는 CS 권한(resolveCsCouponAuthority)을 요구하고,
 * 권한 검증 전에는 복호화가 일어나지 않아야 한다.
 *
 * 생성자 의존성이 많아 Object.create 로 생성자 우회 후 메서드만 격리 테스트한다.
 */
describe('CustomerServiceService.getUnmaskedDeliveryTarget — 권한검사(HIGH)', () => {
  const operator = { id: 9, email: 'op@enmad.com' } as any;

  const buildOrderDelivery = (productType?: IProductType) =>
    ({
      id: 5001,
      deliveryMethod: 'MMS',
      barCode: null,
      emailReceiverPhone: null,
      deliveryTarget: 'enc',
      orderProductMapping: { product: productType ? { type: productType } : undefined },
    }) as any;

  const makeSut = (orderDelivery: any, authImpl?: jest.Mock) => {
    const sut: any = Object.create(CustomerServiceService.prototype);
    // §9 컷오버 게이트 — 단위 테스트 기본값은 '미전환 건'(legacy 경로 그대로 통과).
    (sut as any).cutoverGuard = {
      assertLegacyAllowed: jest.fn().mockResolvedValue(undefined),
      assertRefundExecutionAllowed: jest.fn().mockResolvedValue(undefined),
      isCutover: jest.fn().mockResolvedValue(false),
      splitLegacyAllowed: jest.fn(async (ids: number[]) => ({ allowed: ids, blocked: [] })),
    };
    sut.orderDeliveryRepository = { findOne: jest.fn().mockResolvedValue(orderDelivery) };
    sut.authService = { authorityValidator: authImpl ?? jest.fn().mockResolvedValue(undefined) };
    // 이메일 형태로 반환해 PhoneUtil 경로를 피한다(권한 통과 케이스에서만 호출됨).
    sut.cryptoCipher = { decryptDeliveryTarget: jest.fn().mockReturnValue('user@test.com') };
    return sut;
  };

  it('권한 없는 사용자면 거부하고 복호화하지 않는다', async () => {
    const sut = makeSut(
      buildOrderDelivery(IProductType.GENERAL),
      jest.fn().mockRejectedValue(new ForbiddenException('권한이 없습니다.')),
    );

    await expect(sut.getUnmaskedDeliveryTarget(operator, { orderDeliveryId: 5001 })).rejects.toThrow(
      ForbiddenException,
    );
    // 권한검사가 복호화보다 먼저 → decrypt 미호출 (개인정보 미노출)
    expect(sut.cryptoCipher.decryptDeliveryTarget).not.toHaveBeenCalled();
  });

  it('CS 대상이 아닌 상품 유형이면 400, 권한검사도 도달하지 않는다', async () => {
    const sut = makeSut(buildOrderDelivery(undefined)); // product.type 없음 → resolveCsCouponAuthority null

    await expect(sut.getUnmaskedDeliveryTarget(operator, { orderDeliveryId: 5001 })).rejects.toThrow(
      BadRequestException,
    );
    await expect(sut.getUnmaskedDeliveryTarget(operator, { orderDeliveryId: 5001 })).rejects.toThrow(
      'CS 대상이 아닌 상품 유형입니다.',
    );
    expect(sut.authService.authorityValidator).not.toHaveBeenCalled();
    expect(sut.cryptoCipher.decryptDeliveryTarget).not.toHaveBeenCalled();
  });

  it('일반/초이스 쿠폰은 CUSTOMER_GENERAL_COUPON 권한을 요구하고 통과 시 복호화값 반환', async () => {
    const sut = makeSut(buildOrderDelivery(IProductType.GENERAL));

    const result = await sut.getUnmaskedDeliveryTarget(operator, { orderDeliveryId: 5001 });

    expect(sut.authService.authorityValidator).toHaveBeenCalledWith(operator, UserAuthSubEnum.CUSTOMER_GENERAL_COUPON);
    expect(result.deliveryTarget).toBe('user@test.com');
  });

  it('SSG 쿠폰은 CUSTOMER_SSG_COUPON 권한을 요구한다', async () => {
    const sut = makeSut(buildOrderDelivery(IProductType.SSG));

    await sut.getUnmaskedDeliveryTarget(operator, { orderDeliveryId: 5001 });

    expect(sut.authService.authorityValidator).toHaveBeenCalledWith(operator, UserAuthSubEnum.CUSTOMER_SSG_COUPON);
  });
});
