import { ForbiddenException } from '@nestjs/common';
import { SsgEventController } from './ssg.event.controller';
import { IUserAuthority } from '../../user/interface/user.authority';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';

describe('SsgEventController', () => {
  const user = {
    id: 1,
    email: 'operator@example.com',
    authority: IUserAuthority.OPERATION_ADMIN,
  };
  const createDto = {
    code: 'event-key',
    no: 'event-no',
    name: 'SSG event',
    startAt: '2026-05-01T00:00:00',
    endAt: '2026-05-31T00:00:00',
    couponExpiration: 60,
    eventPrice: 10000,
  } as any;
  const updateAmountDto = {
    id: 1,
    amount: 10000,
  };

  const createController = () => {
    const ssgEventService = {
      create: jest.fn().mockResolvedValue(undefined),
      updateAmount: jest.fn().mockResolvedValue(undefined),
    };
    const activityLogService = {};
    const authService = {
      authorityValidator: jest.fn().mockResolvedValue(undefined),
    };

    const controller = new SsgEventController(
      ssgEventService as any,
      activityLogService as any,
      authService as any,
    );

    return { controller, ssgEventService, authService };
  };

  describe('create', () => {
    it('SSG 이벤트 생성 전 REFILL_SSG 권한을 검증한다', async () => {
      const { controller, ssgEventService, authService } = createController();

      await controller.create(user, createDto);

      expect(authService.authorityValidator).toHaveBeenCalledWith(user, UserAuthSubEnum.REFILL_SSG);
      expect(ssgEventService.create).toHaveBeenCalledWith(createDto);
    });

    it('권한 검증에 실패하면 SSG 이벤트를 생성하지 않는다', async () => {
      const { controller, ssgEventService, authService } = createController();
      authService.authorityValidator.mockRejectedValue(new ForbiddenException('권한이 없습니다.'));

      await expect(controller.create(user, createDto)).rejects.toBeInstanceOf(ForbiddenException);

      expect(ssgEventService.create).not.toHaveBeenCalled();
    });
  });

  describe('updateAmount', () => {
    it('SSG 이벤트 금액 수정 전 REFILL_SSG 권한을 검증한다', async () => {
      const { controller, ssgEventService, authService } = createController();

      await controller.updateAmount(user, updateAmountDto);

      expect(authService.authorityValidator).toHaveBeenCalledWith(user, UserAuthSubEnum.REFILL_SSG);
      expect(ssgEventService.updateAmount).toHaveBeenCalledWith(updateAmountDto);
    });

    it('권한 검증에 실패하면 SSG 이벤트 금액을 수정하지 않는다', async () => {
      const { controller, ssgEventService, authService } = createController();
      authService.authorityValidator.mockRejectedValue(new ForbiddenException('권한이 없습니다.'));

      await expect(controller.updateAmount(user, updateAmountDto)).rejects.toBeInstanceOf(ForbiddenException);

      expect(ssgEventService.updateAmount).not.toHaveBeenCalled();
    });
  });
});