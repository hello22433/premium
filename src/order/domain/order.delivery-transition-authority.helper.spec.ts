import { IUserAuthority } from '../../user/interface/user.authority';
import {
  canForceConfirmDelivery,
  canTransitionDelivery,
} from './order.delivery-transition-authority.helper';

describe('order delivery transition authority', () => {
  describe('canTransitionDelivery', () => {
    it('직발송은 주문 생성자만 허용한다', () => {
      const order = { userId: 10, clientUserId: null, operationUserId: null };

      expect(canTransitionDelivery({ id: 10, authority: IUserAuthority.CORPORATE_ADMIN }, order)).toBe(true);
      expect(canTransitionDelivery({ id: 11, authority: IUserAuthority.CORPORATE_ADMIN }, order)).toBe(false);
    });

    it('대행발송은 배정된 운영 담당자만 허용한다', () => {
      const order = { userId: 20, clientUserId: 30, operationUserId: 20 };

      expect(canTransitionDelivery({ id: 20, authority: IUserAuthority.OPERATION_ADMIN }, order)).toBe(true);
      expect(canTransitionDelivery({ id: 30, authority: IUserAuthority.CORPORATE_ADMIN }, order)).toBe(false);
      expect(canTransitionDelivery({ id: 21, authority: IUserAuthority.OPERATION_ADMIN }, order)).toBe(false);
    });

    it('최고 관리자는 모든 주문을 허용한다', () => {
      const order = { userId: 10, clientUserId: 30, operationUserId: 20 };

      expect(canTransitionDelivery({ id: 99, authority: IUserAuthority.SUPER_ADMIN }, order)).toBe(true);
    });
  });

  describe('canForceConfirmDelivery', () => {
    it('최고 관리자와 운영 관리자만 강제확정을 허용한다', () => {
      expect(canForceConfirmDelivery({ id: 1, authority: IUserAuthority.SUPER_ADMIN })).toBe(true);
      expect(canForceConfirmDelivery({ id: 2, authority: IUserAuthority.OPERATION_ADMIN })).toBe(true);
      expect(canForceConfirmDelivery({ id: 3, authority: IUserAuthority.CORPORATE_ADMIN })).toBe(false);
    });
  });
});
