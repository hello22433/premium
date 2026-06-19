import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { OrderRealProductController } from './order.real.product.controller';

describe('OrderRealProductController access control', () => {
  it('담당자 리스트 조회 API는 인증 가드를 적용한다', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, OrderRealProductController.prototype.getAdminUserList);

    expect(guards).toContain(AuthUserAuthorizationGuard);
  });
});
