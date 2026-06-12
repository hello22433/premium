import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, Matches } from 'class-validator';
import { PROD_TYPE_PATTERN } from './erp.product.query.dto';

// 단건 조회 path param: 품목코드 단건 (최대 20자)
export class ErpProductDetailParamDto {
  @ApiProperty({ description: '품목코드 (최대 20자)' })
  @IsString()
  @MaxLength(20)
  prodCd: string;
}

// 단건 조회 query: 품목구분 (목록과 동일 제약)
export class ErpProductDetailQueryDto {
  @ApiPropertyOptional({
    description: '품목구분 (0:원재료, 1:제품, 2:반제품, 3:상품, 4:부재료, 7:무형상품, 여러 개: ∬ 구분)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Matches(PROD_TYPE_PATTERN, { message: 'prodType 은 숫자 코드와 ∬ 구분자만 허용됩니다.' })
  prodType?: string;
}
