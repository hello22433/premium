import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  constructor() {}

  @Get('/health-check')
  healthCheck(): string {
    // DeliveryCreateCouponImage('/public/coupon/ssg_goods.jpg', '테스트 상품', '12345891758917294', '테스트 교환처', 60);
    return 'health-check';
  }
}
