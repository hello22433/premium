import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsNotEmpty, IsNumber, IsOptional, Matches } from 'class-validator';
import { passwordRegex } from '../../user_find/domain/user.password.regex';
import { IUserBusinessType } from '../interface/user.business.type';

export class UserExistEmailReqDto {
  @ApiProperty({
    description: '중복 검사 하고자 하는 이메일',
  })
  // =======================
  @IsNotEmpty()
  @IsEmail()
  readonly email: string;
}

export class UserSignUpReqDto {
  @ApiProperty({
    type: String,
    description: '가입하고자 하는 email',
  })
  // =================================
  @IsNotEmpty()
  @IsEmail()
  readonly email: string;

  @ApiProperty({
    type: String,
    description: '비밀번호 최소 6글자',
  })
  // =================================
  @IsNotEmpty()
  @Matches(passwordRegex)
  readonly password: string;

  @ApiProperty({
    type: String,
    description: '담당자 이름',
  })
  // =================================
  @IsNotEmpty()
  readonly personName: string;

  @ApiProperty({
    type: String,
    description: '담당자 연락처',
  })
  // =================================
  @IsNotEmpty()
  readonly personPhoneNumber: string;

  @ApiProperty({
    type: String,
    description: '담당자 이메일',
  })
  // =================================
  @IsNotEmpty()
  @IsEmail()
  readonly personEmail: string;

  @ApiPropertyOptional({
    enum: IUserBusinessType,
    description: '담당자 이메일',
  })
  // =================================
  @IsEnum(IUserBusinessType)
  @IsOptional()
  readonly businessType: IUserBusinessType | null;

  @ApiPropertyOptional({
    description: '법인 등록 번호',
  })
  // =================================
  @IsOptional()
  corporateNumber: string | null;

  @ApiProperty({
    description: '사업자 등록 번호',
  })
  // =================================
  @IsNotEmpty()
  businessNumber: string;

  @ApiProperty({
    description: '사업자 명',
  })
  // =================================
  @IsNotEmpty()
  businessName: string;

  @ApiProperty({
    description: '사업자 주소',
  })
  // =================================
  @IsNotEmpty()
  businessAddress: string;

  @ApiProperty({
    description: '사업자 연락처',
  })
  // =================================
  @IsNotEmpty()
  businessPhoneNumber: string;

  @ApiProperty({
    description: '허용 ip',
  })
  // =================================
  @IsNotEmpty()
  ip: string;

  @ApiPropertyOptional({
    description: '업태',
  })
  // =================================
  @IsOptional()
  industryType: string | null;

  @ApiPropertyOptional({
    description: '종목',
  })
  // =================================
  @IsOptional()
  industryItem: string | null;
}

export class UserGetAccessByRefreshReqDto {
  @ApiProperty({
    type: String,
    description: '발급받았던 refreshToken',
  })
  // ================================
  @IsNotEmpty()
  token: string;
}

export class UserGetRefreshByRefreshReqDto {
  @ApiProperty({
    type: String,
    description: '발급받았던 refreshToken',
  })
  // ================================
  @IsNotEmpty()
  token: string;
}

export class UserLoginByEmailPasswordReqDto {
  @ApiProperty({
    type: String,
    description: '가입하고자 하는 email',
  })
  // =================================
  @IsNotEmpty()
  @IsEmail()
  readonly email: string;

  @ApiProperty({
    type: String,
    description: '비밀번호',
  })
  // =================================
  @IsNotEmpty()
  @Matches(passwordRegex)
  readonly password: string;
}

export class UserLoginEmailSendReqDto {
  @ApiProperty({
    type: String,
    description: '계정 이메일 (로그인 ID)',
  })
  // =================================
  @IsNotEmpty()
  @IsEmail()
  readonly email: string;

  @ApiProperty({
    type: String,
    description: '인증코드를 받을 담당자 이메일',
  })
  // =================================
  @IsNotEmpty()
  @IsEmail()
  readonly targetEmail: string;
}

export class UserLoginEmailVerifyReqDto {
  @ApiProperty({
    description: 'email send history id',
  })
  // =================================
  @IsNotEmpty()
  @IsNumber()
  readonly id: number;

  @ApiProperty({
    description: '로그인 인증 이메일 보내고자 하는 email',
  })
  // =================================
  @IsNotEmpty()
  @IsEmail()
  readonly email: string;

  @ApiProperty({
    description: '로그인 이메일 인증 코드',
  })
  // =================================
  @IsNotEmpty()
  readonly code: string;
}
