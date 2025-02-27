import { ApiProperty } from '@nestjs/swagger';

export class UserFindIdResDto {
  @ApiProperty({
    description: '계정 email',
  })
  email: string;
}

export class UserFindResetPasswordSendResDto {
  @ApiProperty({
    description: 'email send history id',
  })
  id: number;
}
