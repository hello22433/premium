import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class OrderReceiveAlimTalkReqDto {
  @ApiProperty({
    description: 'encryptKey',
  })
  // ===============================
  @IsNotEmpty()
  @IsString()
  encryptKey: string;

  @ApiProperty({
    description: '수신 핸드폰 번호',
  })
  // ===============================
  @IsNotEmpty()
  @IsString()
  phoneNumber: string;
}

export class OrderReceiveEmailReqDto {
  @ApiProperty({
    description: 'encryptKey',
  })
  // ===============================
  @IsNotEmpty()
  @IsString()
  encryptKey: string;

  @ApiProperty({
    description: '인증 번호',
  })
  // ===============================
  @IsNotEmpty()
  @IsString()
  code: string;
}

export class OrderReceiveSendToMMsEmailReqDto {
  @ApiProperty({
    description: 'receive email return encryptKey',
  })
  // ===============================
  @IsNotEmpty()
  @IsString()
  sendEncryptKey: string;

  @ApiProperty({
    description: '수신받을 핸드폰 번호 ',
  })
  // ===============================
  @IsNotEmpty()
  phoneNumber: string;
}
