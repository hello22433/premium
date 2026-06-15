import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { OrderProductCreateTempDto } from './order.product.create.temp.dto';
import { ManualEntryItemDto } from './order.manual.entry.dto';

export class OrderCreateDto {
  @ApiPropertyOptional({
    description: '과금 대상 담당자 ID (대행주문 시 사용)',
  })
  // =================================================
  @IsOptional()
  @IsNumber()
  clientUserId?: number;

  @ApiProperty({
    description: '이벤트 명',
    default: '',
  })
  // =================================================
  @IsString()
  eventName: string;

  @ApiPropertyOptional({
    description: '미리보기 상단 이미지 url, 없으면 기본 이미지 사용',
  })
  // =================================================
  @IsOptional()
  topImagePath?: string | null;

  @ApiPropertyOptional({
    description: '미리보기 중간 이미지 url, 없으면 기본 이미지 사용',
  })
  // =================================================
  @IsOptional()
  midImagePath?: string | null;

  @ApiProperty({
    description: '상품 수량',
  })
  // =================================
  @IsArray() // 배열임을 검증
  @ValidateNested({ each: true })
  @Type(() => OrderProductCreateTempDto)
  orderProductList: OrderProductCreateTempDto[];

  @ApiPropertyOptional({
    description: '수기등록 원본 데이터 목록',
  })
  // =================================
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ManualEntryItemDto)
  manualEntryList?: ManualEntryItemDto[];
}
