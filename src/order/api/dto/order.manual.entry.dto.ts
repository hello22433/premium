import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';

export class ManualEntryItemDto {
  @ApiProperty({ description: '전화번호 (평문)' })
  @IsNotEmpty()
  @IsString()
  phoneNumber: string;

  @ApiProperty({ description: '발송금액' })
  @IsNotEmpty()
  @IsNumber()
  sendAmount: number;

  @ApiPropertyOptional({ description: '대치문자 1' })
  @IsOptional()
  @IsString()
  replaceCharacter1?: string;

  @ApiPropertyOptional({ description: '대치문자 2' })
  @IsOptional()
  @IsString()
  replaceCharacter2?: string;

  @ApiPropertyOptional({ description: '대치문자 3' })
  @IsOptional()
  @IsString()
  replaceCharacter3?: string;
}

export class ManualEntryViewDto {
  rowIndex: number;
  phoneNumber: string;
  sendAmount: number;
  replaceCharacter1: string | null;
  replaceCharacter2: string | null;
  replaceCharacter3: string | null;
}
