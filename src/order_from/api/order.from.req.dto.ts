import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty } from 'class-validator';

export class OrderFromCreatePhoneReqDto {
  @ApiProperty({
    description: '발신 핸드폰 번호',
  })
  // ==============================
  @IsNotEmpty()
  from: string;
}

export class OrderFromCreateEmailReqDto {
  @ApiProperty({
    description: '발신 이메일',
  })
  // ==============================
  @IsNotEmpty()
  from: string;
}
