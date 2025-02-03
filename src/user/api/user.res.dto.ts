import { LoginTokenResDto, TokenDto } from '../../auth/api/token.res.dto';
import { ApiProperty } from '@nestjs/swagger';
import { IUserAuthority } from '../interface/user.authority';

export class UserLoginByEmailPasswordResDto extends LoginTokenResDto {
  @ApiProperty({
    type: String,
    description: '로그인한 유저의 이름 ',
  })
  // =====================================================
  readonly personName: string;

  @ApiProperty({
    description: '로그인 유저 권한',
  })
  // =====================================================
  readonly authority: IUserAuthority;
}

export class UserAccessByRefreshResDto {
  @ApiProperty({
    type: TokenDto,
    description: 'access 토큰 정보',
  })
  // =====================================================
  readonly accessToken: TokenDto;
}

export class UserRefreshByRefreshResDto extends LoginTokenResDto {}
