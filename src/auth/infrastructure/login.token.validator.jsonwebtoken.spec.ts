import { ILoginUserInfo } from '../interface/login.user';
import { LoginTokenValidatorJsonwebtoken } from './login.token.validator.jsonwebtoken';
import { mock, MockProxy } from 'jest-mock-extended';
import { MockConfigService } from '../../common/test/config.service';
import { LoginUserInfoTest } from '../../../test/common/login.user.info.test';
import { sign } from 'jsonwebtoken';
import { UnauthorizedException } from '@nestjs/common';

describe('login token validator With jsonwebtoken 테스트', () => {
  const configService: MockProxy<MockConfigService> = mock<MockConfigService>();

  const sut = new LoginTokenValidatorJsonwebtoken(configService);

  it('issuance 토큰 발급 테스트', () => {
    const givenLoginUser: ILoginUserInfo = {
      ...LoginUserInfoTest(),
      id: 1,
      email: 'test@test.com',
    };
    configService.getOrThrow.calledWith('TOKEN_SECRET_KEY').mockReturnValue('SECRET');
    configService.getOrThrow.calledWith('ACCESS_TOKEN_EXPIRE_SECOND').mockReturnValue('3600');
    configService.getOrThrow.calledWith('REFRESH_TOKEN_EXPIRE_SECOND').mockReturnValue('36000');

    const result = sut.issuance(givenLoginUser);

    const now = new Date();
    expect(result.accessToken).toBeDefined();
    expect(new Date(result.accessToken.expiredAt).getTime()).toBeGreaterThan(now.getTime());
    expect(result.refreshToken).toBeDefined();
    expect(new Date(result.refreshToken.expiredAt).getTime()).toBeGreaterThan(now.getTime());
  });

  describe('토큰 type 클레임 / validateByToken type 검증', () => {
    const SECRET = 'SECRET';

    const givenLoginUser: ILoginUserInfo = {
      ...LoginUserInfoTest(),
      id: 1,
      email: 'test@test.com',
    };

    const setConfig = () => {
      configService.getOrThrow.calledWith('TOKEN_SECRET_KEY').mockReturnValue(SECRET);
      configService.getOrThrow.calledWith('ACCESS_TOKEN_EXPIRE_SECOND').mockReturnValue('3600');
      configService.getOrThrow.calledWith('REFRESH_TOKEN_EXPIRE_SECOND').mockReturnValue('36000');
    };

    it('issuance 가 access 에는 type:access, refresh 에는 type:refresh 클레임을 박는다', () => {
      setConfig();

      const result = sut.issuance(givenLoginUser);

      // access 토큰은 access type 으로 검증 통과
      expect(sut.validateByToken(result.accessToken.value, 'access').id).toBe(1);
      // refresh 토큰은 refresh type 으로 검증 통과
      expect(sut.validateByToken(result.refreshToken.value, 'refresh').id).toBe(1);
    });

    it('access 토큰을 refresh 로 검증하면 타입 불일치로 거부한다', () => {
      setConfig();
      const result = sut.issuance(givenLoginUser);

      expect(() => sut.validateByToken(result.accessToken.value, 'refresh')).toThrow(UnauthorizedException);
    });

    it('refresh 토큰을 access(기본)로 검증하면 타입 불일치로 거부한다', () => {
      setConfig();
      const result = sut.issuance(givenLoginUser);

      expect(() => sut.validateByToken(result.refreshToken.value)).toThrow(UnauthorizedException);
    });

    it('type 클레임이 없는 레거시 토큰은 grace 로 통과시킨다', () => {
      setConfig();
      const legacyToken = sign({ id: 1, email: 'test@test.com', authority: givenLoginUser.authority }, SECRET);

      expect(sut.validateByToken(legacyToken).id).toBe(1);
      expect(sut.validateByToken(legacyToken, 'refresh').id).toBe(1);
    });
  });
});
