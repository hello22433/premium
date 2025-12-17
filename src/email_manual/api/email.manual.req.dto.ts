import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class EmailManualUpsertReqDto {
  @ApiProperty({
    description: '이메일 사용방법 내용',
  })
  @IsNotEmpty()
  @IsString()
  content: string;
}
