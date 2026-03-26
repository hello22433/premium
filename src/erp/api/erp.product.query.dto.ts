import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsIn } from 'class-validator';

export class ErpProductListQueryDto {
  @ApiPropertyOptional({ description: '품목코드 (여러 개: ∬ 구분, 최대 20000자)' })
  @IsOptional()
  @IsString()
  prodCd?: string;

  @ApiPropertyOptional({ description: '콤마 포함 여부', enum: ['Y', 'N'] })
  @IsOptional()
  @IsIn(['Y', 'N'])
  commaFlag?: 'Y' | 'N';

  @ApiPropertyOptional({ description: '품목구분 (0:원재료, 1:제품, 2:반제품, 3:상품, 4:부재료, 7:무형상품, 여러 개: ∬ 구분)' })
  @IsOptional()
  @IsString()
  prodType?: string;

  @ApiPropertyOptional({ description: '품목코드 범위 시작 (최대 20자)' })
  @IsOptional()
  @IsString()
  fromProdCd?: string;

  @ApiPropertyOptional({ description: '품목코드 범위 끝 (최대 20자)' })
  @IsOptional()
  @IsString()
  toProdCd?: string;
}
