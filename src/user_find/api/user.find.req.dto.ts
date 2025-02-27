import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsNumber } from 'class-validator';

export class UserFindIdReqDto {
  @ApiProperty({
    description: '사업자 등록 번호',
  })
  // ===============================
  @IsNotEmpty()
  businessNumber: string;

  @ApiProperty({
    description: '담당자 이름',
  })
  // ===============================
  @IsNotEmpty()
  personName: string;

  @ApiProperty({
    description: '휴대폰 번호',
  })
  // ===============================
  @IsNotEmpty()
  personPhoneNumber: string;
}

export class UserFindResetPasswordSendReqDto {
  @ApiProperty({
    description: '계정 email',
  })
  // ===============================
  @IsNotEmpty()
  @IsEmail()
  email: string;

  @ApiProperty({
    description: '계정 사업자 등록 번호',
  })
  // ===============================
  @IsNotEmpty()
  businessNumber: string;

  @ApiProperty({
    description: '이름',
  })
  // ===============================
  @IsNotEmpty()
  personName: string;

  @ApiProperty({
    description: '휴대폰 번호',
  })
  // ===============================
  @IsNotEmpty()
  personPhoneNumber: string;
}

export class UserFindResetPasswordVerifyReqDto {
  @ApiProperty({
    description: 'email send history id',
  })
  // ===============================
  @IsNotEmpty()
  @IsNumber()
  id: number;

  @ApiProperty({
    description: '인증 코드',
  })
  // ===============================
  @IsNotEmpty()
  code: string;

  @ApiProperty({
    description: '계정 email',
  })
  // ===============================
  @IsNotEmpty()
  @IsEmail()
  email: string;
}
