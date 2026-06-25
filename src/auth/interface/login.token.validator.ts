import { ILoginToken, TokenType } from './token';
import { ILoginUserInfo } from './login.user';

export interface ILoginTokenValidator {
  issuance(userLogin: ILoginUserInfo): ILoginToken;
  validateByToken(token: string, expectedType?: TokenType): ILoginUserInfo;
}
