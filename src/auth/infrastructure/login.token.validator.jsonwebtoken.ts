import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtPayload, sign, TokenExpiredError, verify } from 'jsonwebtoken';
import { addSeconds, format } from 'date-fns';
import { ILoginToken, TokenType } from '../interface/token';
import { ILoginTokenValidator } from '../interface/login.token.validator';
import { ConfigService } from '@nestjs/config';
import { ILoginUserInfo } from '../interface/login.user';
import { DateFormatStr } from '../../common/domain/date.format.str';

@Injectable()
export class LoginTokenValidatorJsonwebtoken implements ILoginTokenValidator {
  constructor(private configService: ConfigService) {}

  private transformUserInfo(payload: JwtPayload): ILoginUserInfo {
    return {
      id: payload.id,
      email: payload.email,
      authority: payload.authority,
    };
  }

  // 토큰 발급
  issuance(loginUser: ILoginUserInfo): ILoginToken {
    const now = new Date();
    const secretJwtKey: string = this.configService.getOrThrow('TOKEN_SECRET_KEY');

    const accessTokenExpireSecond = +this.configService.getOrThrow('ACCESS_TOKEN_EXPIRE_SECOND');
    const refreshTokenExpireSecond = +this.configService.getOrThrow('REFRESH_TOKEN_EXPIRE_SECOND');

    const accessTokenExpire = addSeconds(now, accessTokenExpireSecond);
    const refreshTokenExpire = addSeconds(now, refreshTokenExpireSecond);

    const accessToken = sign({ ...loginUser, type: 'access' }, secretJwtKey, {
      expiresIn: accessTokenExpireSecond,
    });
    const refreshToken = sign({ ...loginUser, type: 'refresh' }, secretJwtKey, {
      expiresIn: refreshTokenExpireSecond,
    });

    return {
      accessToken: {
        value: accessToken,
        expiredAt: format(accessTokenExpire, DateFormatStr),
      },
      refreshToken: {
        value: refreshToken,
        expiredAt: format(refreshTokenExpire, DateFormatStr),
      },
    };
  }

  // 토큰 유효성 검증 (expectedType 으로 access/refresh 용도 구분, 기본값 access)
  validateByToken(token: string, expectedType: TokenType = 'access') {
    const secretJwtKey: string = this.configService.getOrThrow('TOKEN_SECRET_KEY');

    let payload: JwtPayload;
    try {
      const tokenDecoded = verify(token, secretJwtKey, { complete: true });
      payload = tokenDecoded.payload as JwtPayload;
    } catch (e) {
      if (e) {
        if (e instanceof TokenExpiredError) {
          throw new UnauthorizedException('토큰만료');
        }
        throw new UnauthorizedException('토큰 에러');
      }
      throw new Error(e);
    }

    // type 클레임이 기대 용도와 다르면 거부 (무타입 레거시 토큰도 거부 — access/refresh 교차사용 차단)
    if (payload.type !== expectedType) {
      throw new UnauthorizedException('토큰 타입이 올바르지 않습니다.');
    }

    return this.transformUserInfo(payload);
  }
}
