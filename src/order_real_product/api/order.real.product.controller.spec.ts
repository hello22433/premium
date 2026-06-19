import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { OrderRealProductController } from './order.real.product.controller';

describe('OrderRealProductController access control', () => {
  it('담당자 리스트 조회 API는 인증 가드를 적용한다', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, OrderRealProductController.prototype.getAdminUserList);

    expect(guards).toContain(AuthUserAuthorizationGuard);
  });

  it('배송 추적 상세 조회 API는 인증 사용자 정보를 서비스에 전달한다', () => {
    const orderRealProductService = {
      getDeliveryTrackingDetail: jest.fn(),
    };
    const controller = new OrderRealProductController(orderRealProductService as any, {} as any, {} as any);
    const user = { id: 100 };
    const getParam = { id: 20 };

    controller.getDeliveryTrackingDetail(user as any, getParam as any);

    expect(orderRealProductService.getDeliveryTrackingDetail).toHaveBeenCalledWith(user, getParam);
  });
});
