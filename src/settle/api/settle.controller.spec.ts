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

    const controller = new SettleController(
      settleService as any,
      activityLogService as any,
      authService as any,
    );

    return { controller, settleService, authService };
  };

  describe('updateUserPerOrder', () => {
    it('requires SETTLE_USER_MANAGE authority before updating settlement status', async () => {
      const { controller, settleService, authService } = createController();

      await controller.updateUserPerOrder(user, dto);

      expect(authService.authorityValidator).toHaveBeenCalledWith(user, UserAuthSubEnum.SETTLE_USER_MANAGE);
      expect(settleService.updateUserPerOrder).toHaveBeenCalledWith(dto);
    });

    it('does not update settlement status when authority validation fails', async () => {
      const { controller, settleService, authService } = createController();
      authService.authorityValidator.mockRejectedValue(new ForbiddenException('권한이 없습니다.'));

      await expect(controller.updateUserPerOrder(user, dto)).rejects.toBeInstanceOf(ForbiddenException);

      expect(settleService.updateUserPerOrder).not.toHaveBeenCalled();
    });
  });
});