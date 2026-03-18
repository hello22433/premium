import { LoginTokenResDto, TokenDto } from '../../auth/api/token.res.dto';
import { ApiProperty } from '@nestjs/swagger';
import { IUserAuthority } from '../interface/user.authority';
import { LoginVerifyMethod } from '../interface/login.verify.method';

export class UserLoginByEmailPasswordResDto {
  @ApiProperty({
    type: Number,
    description: '로그인한 유저의 ID',
  })
  // =====================================================
  readonly userId: number;

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
    type: String,
    description: '로그인한 유저의 이메일',
  })
  // =====================================================
  readonly email: string;

  @ApiProperty({
    description: '비밀번호 리셋을 진행한 경우, true 일 경우 비밀번호 변경 프로세스를 진행해야 합니다.',
  })
  readonly isPasswordReset: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    enum: ['TEMP', 'EXPIRED'],
    description:
      '비밀번호 재설정 사유. TEMP: 임시비밀번호 발급, EXPIRED: 비밀번호 변경 기간 만료, null: 재설정 불필요',
  })
  readonly passwordResetReason: 'TEMP' | 'EXPIRED' | null;

  @ApiProperty({
    description: '로그인 이메일 인증 진행 여부 ex) true : 인증한경우 false: 인증하지 않은 경우',
  })
  readonly isEmailVerify: boolean;

  @ApiProperty({
    type: Date,
    nullable: true,
    description: '비밀번호 마지막 변경 일시 (null이면 임시 비밀번호)',
  })
  readonly passwordChangedAt: Date | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: '비밀번호 만료 기간 (일 단위)',
  })
  readonly passwordExpiryDays: number | null;

  @ApiProperty({
    type: [String],
    description: '담당자 이메일 목록',
  })
  readonly personEmails: string[];

  @ApiProperty({
    description: '이메일 선택 필요 여부 (담당자 이메일이 2개 이상이고 미인증 시 true)',
  })
  readonly needEmailSelection: boolean;

  @ApiProperty({
    enum: LoginVerifyMethod,
    description: '로그인 인증 방식 (EMAIL: 이메일 인증, PHONE: 휴대번호 인증)',
  })
  readonly loginVerifyMethod: LoginVerifyMethod;

  @ApiProperty({
    type: String,
    description: '마스킹된 담당자 연락처 (예: *******1234)',
  })
  readonly maskedPhoneNumber: string;
}

export class UserLoginPhoneResDto {
  @ApiProperty({
    description: '인증 이력 id',
  })
  id: number;
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
