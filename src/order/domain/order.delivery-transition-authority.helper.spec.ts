import { IUserAuthority } from '../../user/interface/user.authority';
import { IUserStatus } from '../../user/interface/user.status';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';
import { IOrderType } from '../interface/order.type';
import { IOrderStatus } from '../interface/order.status';
import {
  canForceConfirmDelivery,
  canTransitionDelivery,
  shouldExposeSsgBalanceCheck,
} from './order.delivery-transition-authority.helper';

describe('order delivery transition authority', () => {
  const operationAdmin = {
    id: 11,
    authority: IUserAuthority.OPERATION_ADMIN,
    status: IUserStatus.USED,
    authorityList: null,
  };

  describe('canTransitionDelivery', () => {
    it('직발송은 운영 관리자만 허용한다', () => {
      const order = { userId: 10, clientUserId: null, operationUserId: null, type: IOrderType.GENERAL };

      expect(canTransitionDelivery({ ...operationAdmin, id: 10, authority: IUserAuthority.CORPORATE_ADMIN }, order)).toBe(false);
      expect(canTransitionDelivery(operationAdmin, order)).toBe(true);
      expect(canTransitionDelivery({ ...operationAdmin, authority: IUserAuthority.CORPORATE_ADMIN }, order)).toBe(false);
    });

    it('대행발송은 배정된 운영 담당자만 허용한다', () => {
      const order = { userId: 20, clientUserId: 30, operationUserId: 20, type: IOrderType.GENERAL };

      expect(canTransitionDelivery({ ...operationAdmin, id: 20 }, order)).toBe(true);
      expect(canTransitionDelivery({ ...operationAdmin, id: 20, authority: IUserAuthority.CORPORATE_ADMIN }, order)).toBe(false);
      expect(canTransitionDelivery({ ...operationAdmin, id: 30, authority: IUserAuthority.CORPORATE_ADMIN }, order)).toBe(false);
      expect(canTransitionDelivery({ ...operationAdmin, id: 21 }, order)).toBe(false);
    });

    it('최고 관리자는 모든 주문을 허용한다', () => {
      const order = { userId: 10, clientUserId: 30, operationUserId: 20, type: IOrderType.GENERAL };

      expect(canTransitionDelivery({ ...operationAdmin, id: 99, authority: IUserAuthority.SUPER_ADMIN }, order)).toBe(true);
    });

    it('비활성 계정은 차단한다', () => {
      const order = { userId: 10, clientUserId: null, operationUserId: null, type: IOrderType.GENERAL };

      expect(canTransitionDelivery({ ...operationAdmin, status: IUserStatus.NOT_USED }, order)).toBe(false);
    });

    it('일반 발송 권한이 제거된 계정은 일반 발송을 차단한다', () => {
      const order = { userId: 10, clientUserId: null, operationUserId: null, type: IOrderType.GENERAL };

      expect(canTransitionDelivery({ ...operationAdmin, authorityList: UserAuthSubEnum.SEND_SSG }, order)).toBe(false);
    });

    it('SSG 발송 권한이 제거된 계정은 SSG 발송을 차단한다', () => {
      const order = { userId: 10, clientUserId: null, operationUserId: null, type: IOrderType.SSG };

      expect(canTransitionDelivery({ ...operationAdmin, authorityList: UserAuthSubEnum.SEND_GENERAL }, order)).toBe(false);
    });
  });

  describe('canForceConfirmDelivery', () => {
    it('최고 관리자와 운영 관리자만 강제확정을 허용한다', () => {
      expect(canForceConfirmDelivery({ ...operationAdmin, id: 1, authority: IUserAuthority.SUPER_ADMIN })).toBe(true);
      expect(canForceConfirmDelivery({ ...operationAdmin, id: 2 })).toBe(true);
      expect(canForceConfirmDelivery({ ...operationAdmin, id: 3, authority: IUserAuthority.CORPORATE_ADMIN })).toBe(false);
    });

    it('비활성 계정의 강제확정을 차단한다', () => {
      expect(canForceConfirmDelivery({ ...operationAdmin, status: IUserStatus.NOT_USED })).toBe(false);
    });
  });

  describe('shouldExposeSsgBalanceCheck', () => {
    const ssgReviewOrder = {
      userId: 10,
      clientUserId: null,
      operationUserId: null,
      type: IOrderType.SSG,
      status: IOrderStatus.REVIEW_COMPLETE,
    };

    it('SSG + 검토완료 + 발송확정 권한자면 노출(true)', () => {
      expect(shouldExposeSsgBalanceCheck(operationAdmin, ssgReviewOrder)).toBe(true);
      expect(
        shouldExposeSsgBalanceCheck(
          { ...operationAdmin, id: 99, authority: IUserAuthority.SUPER_ADMIN },
          ssgReviewOrder,
        ),
      ).toBe(true);
    });

    it('고객사(CORPORATE_ADMIN)에게는 노출 안 함(false) — 민감 재무데이터 방어', () => {
      expect(
        shouldExposeSsgBalanceCheck(
          { ...operationAdmin, authority: IUserAuthority.CORPORATE_ADMIN },
          ssgReviewOrder,
        ),
      ).toBe(false);
    });

    it('대행주문 비소유 운영자는 노출 안 함(false)', () => {
      const agencyOrder = { ...ssgReviewOrder, clientUserId: 30, operationUserId: 999 };
      expect(shouldExposeSsgBalanceCheck({ ...operationAdmin, id: 11 }, agencyOrder)).toBe(false);
    });

    it('비-SSG 주문은 노출 안 함(false)', () => {
      expect(
        shouldExposeSsgBalanceCheck(operationAdmin, { ...ssgReviewOrder, type: IOrderType.GENERAL }),
      ).toBe(false);
    });

    it('발송확정 전(REVIEW_COMPLETE)이 아니면 노출 안 함(false)', () => {
      expect(
        shouldExposeSsgBalanceCheck(operationAdmin, {
          ...ssgReviewOrder,
          status: IOrderStatus.DELIVERY_CONFIRMED,
        }),
      ).toBe(false);
    });
  });
});
