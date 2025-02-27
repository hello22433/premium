import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, Matches } from 'class-validator';
import { passwordRegex } from '../../user_find/domain/user.password.regex';

export class UserInfoChangePasswordReqDto {
  @ApiProperty({
    description: '변경하고자 하는 비밀번호',
  })
  // ==============================
  @IsNotEmpty()
  @Matches(passwordRegex)
  password: string;
}
