import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { LoginTokenValidatorJsonwebtoken } from '../infrastructure/login.token.validator.jsonwebtoken';
import { IUserAuthority } from '../../user/interface/user.authority';

@Injectable()
export class AuthUserSuperAndOperationAdminGuard implements CanActivate {
  constructor(
    @Inject('ILoginTokenValidator')
    private loginTokenValidator: LoginTokenValidatorJsonwebtoken,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const ctx = context.switchToHttp();
    const request = ctx.getRequest();
    const bearerToken = request.get('Authorization');
    if (!bearerToken) {
      throw new UnauthorizedException('토큰이 존재하지 않습니다.');
    }
    const token = bearerToken.split(' ')[1];

    request.user = this.loginTokenValidator.validateByToken(token);
    if (
      request.user.authority !== IUserAuthority.SUPER_ADMIN &&
      request.user.authority !== IUserAuthority.OPERATION_ADMIN
    ) {
      throw new ForbiddenException('권한이 없습니다.');
    }

    return true;
  }
}
