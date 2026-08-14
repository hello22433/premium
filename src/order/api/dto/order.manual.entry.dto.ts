import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BadRequestException } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';

export const NormalizeMemo = () =>
  Transform(({ value }: { value: unknown }) => {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value !== 'string') {
      return value;
    }
    if (/[\r\n]/.test(value)) {
      throw new BadRequestException('memo must be a single line');
    }
    return value.trim() || null;
  });

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

  @ApiPropertyOptional({ description: '수신자별 운영자 메모 (고객 미노출)', maxLength: 500, nullable: true })
  @NormalizeMemo()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  memo?: string | null;
}

export class ManualEntryViewDto {
  rowIndex: number;
  phoneNumber: string;
  sendAmount: number;
  replaceCharacter1: string | null;
  replaceCharacter2: string | null;
  replaceCharacter3: string | null;
  memo: string | null;
}
