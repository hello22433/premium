import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';
import { OrderProductCreateTempDto } from './order.product.create.temp.dto';

export class OrderCreateDto {
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
  @Type(() => OrderProductCreateTempDto)
  orderProductList: OrderProductCreateTempDto[];
}
