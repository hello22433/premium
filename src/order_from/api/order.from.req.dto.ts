import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

export class OrderFromGetPhoneReqQueryDto {
  @ApiProperty({
    description: 'user id',
  })
  // ==============================
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  userId?: number;
}

export class OrderFromCreatePhoneReqDto {
  @ApiProperty({
    description: '발신 핸드폰 번호',
  })
  // ==============================
  @IsNotEmpty()
  from: string;

  @ApiProperty({
    description: 'user id',
  })
  // ==============================
  @IsOptional()
  @IsNumber()
  userId?: number;
}

export class OrderFromCreateEmailReqDto {
  @ApiProperty({
    description: '발신 이메일',
  })
  // ==============================
  @IsNotEmpty()
  from: string;
}

export class OrderFromDeleteEmailReqDto {
  @ApiProperty({
    description: '발신 이메일 ID',
  })
  // ==============================
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  id: number;
}
