import { BadRequestException } from '@nestjs/common';
import { CustomerServiceController } from './api/customer.service.controller';
import { CustomerServiceService } from './application/customer.service.service';
import { IProductType } from '../product/interface/product.type';
import { UserAuthSubEnum } from '../user_management/domain/user.auth.enum';

/**
 * CS 권한 분기(resolveCsCouponAuthority) 회귀 테스트.
 *
 * getList 분류 기준과 동일하게:
 *   SSG               → CUSTOMER_SSG_COUPON
 *   GENERAL / CHOICE  → CUSTOMER_GENERAL_COUPON
 *   그 외(DELIVERY/SELF/REAL)·누락 → CS 대상 아님
 *
 * 컨트롤러 버전은 fail-closed 로 throw, 서비스 버전은 null 반환(호출측이 거부/skip).
 * 생성자 의존성이 많아 Object.create 로 생성자 우회 후 private 메서드만 격리 호출한다.
 */
describe('resolveCsCouponAuthority — 컨트롤러(throw 버전)', () => {
  const sut: any = Object.create(CustomerServiceController.prototype);
  const call = (t?: IProductType) => sut.resolveCsCouponAuthority(t);

  it('SSG → CUSTOMER_SSG_COUPON', () => {
    expect(call(IProductType.SSG)).toBe(UserAuthSubEnum.CUSTOMER_SSG_COUPON);
  });

  it('GENERAL → CUSTOMER_GENERAL_COUPON', () => {
    expect(call(IProductType.GENERAL)).toBe(UserAuthSubEnum.CUSTOMER_GENERAL_COUPON);
  });

  it('CHOICE → CUSTOMER_GENERAL_COUPON (getList 일반 그룹에 포함)', () => {
    expect(call(IProductType.CHOICE)).toBe(UserAuthSubEnum.CUSTOMER_GENERAL_COUPON);
  });

  it.each([IProductType.DELIVERY, IProductType.SELF, IProductType.REAL])(
    'CS 대상이 아닌 타입(%s)은 BadRequestException 으로 거부',
    (type) => {
      expect(() => call(type)).toThrow(BadRequestException);
    },
  );

  it('undefined(상품 누락)도 거부 (fail closed)', () => {
    expect(() => call(undefined)).toThrow(BadRequestException);
  });
});

describe('resolveCsCouponAuthority — 서비스(null 버전)', () => {
  const sut: any = Object.create(CustomerServiceService.prototype);
  const call = (t?: IProductType) => sut.resolveCsCouponAuthority(t);

  it('SSG → CUSTOMER_SSG_COUPON', () => {
    expect(call(IProductType.SSG)).toBe(UserAuthSubEnum.CUSTOMER_SSG_COUPON);
  });

  it('GENERAL → CUSTOMER_GENERAL_COUPON', () => {
    expect(call(IProductType.GENERAL)).toBe(UserAuthSubEnum.CUSTOMER_GENERAL_COUPON);
  });

  it('CHOICE → CUSTOMER_GENERAL_COUPON', () => {
    expect(call(IProductType.CHOICE)).toBe(UserAuthSubEnum.CUSTOMER_GENERAL_COUPON);
  });

  it.each([IProductType.DELIVERY, IProductType.SELF, IProductType.REAL])(
    'CS 대상이 아닌 타입(%s)은 null 반환 (호출측이 거부/skip)',
    (type) => {
      expect(call(type)).toBeNull();
    },
  );

  it('undefined(상품 누락)도 null', () => {
    expect(call(undefined)).toBeNull();
  });
});
