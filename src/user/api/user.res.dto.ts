import { LoginTokenResDto, TokenDto } from '../../auth/api/token.res.dto';
import { ApiProperty } from '@nestjs/swagger';
import { IUserAuthority } from '../interface/user.authority';

export class UserLoginByEmailPasswordResDto {
  @ApiProperty({
    type: TokenDto,
    nullable: true,
    description: 'access 토큰 정보',
  })
  // =====================================================
  readonly accessToken: TokenDto | null;

  @ApiProperty({
    type: TokenDto,
    nullable: true,
    description: 'refresh 토큰 정보',
  })
  // =====================================================
  readonly refreshToken: TokenDto | null;

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

  @ApiProperty({
    description: '비밀번호 리셋을 진행한 경우, true 일 경우 비밀번호 변경 프로세스를 진행해야 합니다.',
  })
  readonly isPasswordReset: boolean;

  @ApiProperty({
    description: '로그인 이메일 인증 진행 여부 ex) true : 인증한경우 false: 인증하지 않은 경우',
  })
  readonly isEmailVerify: boolean;
}

export class UserLoginEmailResDto {
  @ApiProperty({
    description: 'email send history id',
  })
  id: number;
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
