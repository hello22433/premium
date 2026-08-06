import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayNotEmpty, IsArray, IsInt, IsOptional, IsString, ValidateNested } from 'class-validator';

/** PUT 요청 1건. 금액은 canonical 정수 문자열(음수불허·서비스에서 검증). */
export class CreditConfigPutItemDto {
  @ApiProperty({ description: '하위항목 키. 하위 없으면 NONE' })
  @IsString()
  subItemKey: string;

  @ApiProperty({ description: '보증보험 (canonical 정수 문자열)' })
  @IsString()
  insuranceAmount: string;

  @ApiProperty({ description: '선입금 (canonical 정수 문자열)' })
  @IsString()
  prepaidAmount: string;

  @ApiProperty({ description: '기타 (canonical 정수 문자열)' })
  @IsString()
  etcAmount: string;

  @ApiProperty({
    description: 'optimistic lock. 최초 생성은 null, 갱신은 정수',
    nullable: true,
    type: Number,
  })
  @IsOptional()
  @IsInt()
  expectedVersion: number | null;
}

export class CreditConfigPutReqDto {
  @ApiProperty({ type: [CreditConfigPutItemDto], description: 'all-or-nothing 배치' })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => CreditConfigPutItemDto)
  items: CreditConfigPutItemDto[];
}

export class CreditConfigViewDto {
  @ApiProperty() subItemKey: string;
  @ApiProperty() insuranceAmount: string;
  @ApiProperty() prepaidAmount: string;
  @ApiProperty() etcAmount: string;
  @ApiProperty({ description: '협력사 타입별 공식으로 계산된 월 한도' }) monthlyLimit: string;
  @ApiProperty() version: number;
}

export class CreditConfigPutResultDto {
  @ApiProperty() subItemKey: string;
  @ApiProperty() version: number;
}
