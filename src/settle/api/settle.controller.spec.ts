import { ForbiddenException } from '@nestjs/common';
import { SettleController } from './settle.controller';
import { IUserAuthority } from '../../user/interface/user.authority';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';

describe('SettleController', () => {
  const user = {
    id: 1,
    email: 'operator@example.com',
    authority: IUserAuthority.OPERATION_ADMIN,
  };
  const dto = {
    orderId: 10,
    settleStatus: 'SETTLE_COMPLETE',
  } as any;

  const createController = () => {
    const settleService = {
      updateUserPerOrder: jest.fn().mockResolvedValue({ ok: true }),
    };
    const activityLogService = {};
    const authService = {
      authorityValidator: jest.fn().mockResolvedValue(undefined),
    };
    const walletReadService = {
      getSettlementCodeSnapshot: jest.fn(),
      getSettlementCodeUsage: jest.fn(),
    };

    const controller = new SettleController(
      settleService as any,
      activityLogService as any,
      authService as any,
      walletReadService as any,
    );

    return { controller, settleService, authService, walletReadService };
  };

  describe('updateUserPerOrder', () => {
    it('정산상태 변경 전 SETTLE_USER_MANAGE 권한을 검증한다', async () => {
      const { controller, settleService, authService } = createController();

      await controller.updateUserPerOrder(user, dto);

      expect(authService.authorityValidator).toHaveBeenCalledWith(user, UserAuthSubEnum.SETTLE_USER_MANAGE);
      expect(settleService.updateUserPerOrder).toHaveBeenCalledWith(dto);
    });

    it('권한 검증에 실패하면 정산상태 변경을 실행하지 않는다', async () => {
      const { controller, settleService, authService } = createController();
      authService.authorityValidator.mockRejectedValue(new ForbiddenException('권한이 없습니다.'));

      await expect(controller.updateUserPerOrder(user, dto)).rejects.toBeInstanceOf(ForbiddenException);

      expect(settleService.updateUserPerOrder).not.toHaveBeenCalled();
    });
  });
});