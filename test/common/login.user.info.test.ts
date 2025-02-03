import { ILoginUserInfo } from '../../src/auth/interface/login.user';
import { IUserAuthority } from '../../src/user/interface/user.authority';

export const LoginUserInfoTest = (): ILoginUserInfo => {
  return {
    email: 'test@test.com',
    id: 1,
    authority: IUserAuthority.OPERATION_ADMIN,
  };
};
