import { ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuthService } from '../../auth/application/auth.service';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { AuthUserSuperAdminGuard } from '../../auth/api/auth.user.super-admin.guard';
import { AuthUserSuperAndOperationAdminGuard } from '../../auth/api/auth.user.super-operation-admin.guard';
import { IUserAuthority } from '../../user/interface/user.authority';
import { UserAuthSubEnum } from '../domain/user.auth.enum';
import { UserManagementController } from './user.management.controller';
import { UserManagementService } from '../application/user.management.service';

describe('UserManagementController', () => {
  let controller: UserManagementController;
  let authService: { authorityValidator: jest.Mock };
  let userManagementService: { getDetail: jest.Mock };

  beforeEach(async () => {
    authService = { authorityValidator: jest.fn().mockResolvedValue(undefined) };
    userManagementService = { getDetail: jest.fn().mockResolvedValue({}) };

    const module = await Test.createTestingModule({
      controllers: [UserManagementController],
      providers: [
        { provide: UserManagementService, useValue: userManagementService },
        { provide: AuthService, useValue: authService },
      ],
    })
      .overrideGuard(AuthUserAuthorizationGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AuthUserSuperAdminGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AuthUserSuperAndOperationAdminGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(UserManagementController);
  });

  describe('getDetail 소유권·권한 검증', () => {
    const CORPORATE_ADMIN_USER = { id: 5, email: 'corp@test.com', authority: IUserAuthority.CORPORATE_ADMIN };
    const OPERATION_ADMIN_USER = { id: 10, email: 'op@test.com', authority: IUserAuthority.OPERATION_ADMIN };
    const SUPER_ADMIN_USER = { id: 15, email: 'super@test.com', authority: IUserAuthority.SUPER_ADMIN };

    it('CORPORATE_ADMIN: 본인 id → 정상 조회', async () => {
      await expect(controller.getDetail(CORPORATE_ADMIN_USER, { id: 5 })).resolves.toBeDefined();
      expect(userManagementService.getDetail).toHaveBeenCalled();
    });

    it('CORPORATE_ADMIN: 타인 id → ForbiddenException', async () => {
      await expect(controller.getDetail(CORPORATE_ADMIN_USER, { id: 99 })).rejects.toThrow(ForbiddenException);
      expect(userManagementService.getDetail).not.toHaveBeenCalled();
    });

    it('OPERATION_ADMIN: authorityValidator(ACCOUNT) 호출', async () => {
      await controller.getDetail(OPERATION_ADMIN_USER, { id: 5 });

      expect(authService.authorityValidator).toHaveBeenCalledWith(OPERATION_ADMIN_USER, UserAuthSubEnum.ACCOUNT);
    });

    it('SUPER_ADMIN: authorityValidator(ACCOUNT) 호출', async () => {
      await controller.getDetail(SUPER_ADMIN_USER, { id: 5 });

      expect(authService.authorityValidator).toHaveBeenCalledWith(SUPER_ADMIN_USER, UserAuthSubEnum.ACCOUNT);
    });
  });
});
