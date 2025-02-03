import { IUserAuthority } from '../../user/interface/user.authority';

export type ILoginUserInfo = {
  id: number;
  email: string;
  authority: IUserAuthority;
};
