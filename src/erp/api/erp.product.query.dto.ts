import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsIn, MaxLength, Matches } from 'class-validator';

// 품목구분: 허용 코드(0:원재료,1:제품,2:반제품,3:상품,4:부재료,7:무형상품)를 ∬ 로 연결.
// 토큰=유효코드 1자리, ∬ 는 토큰 사이에만(선/후행·이중 구분자 불가).
export const PROD_TYPE_PATTERN = /^[012347](∬[012347])*$/;

export class ErpProductListQueryDto {
  @ApiPropertyOptional({ description: '품목코드 (여러 개: ∬ 구분, 최대 20000자)' })
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  prodCd?: string;

  @ApiPropertyOptional({ description: '콤마 포함 여부', enum: ['Y', 'N'] })
  @IsOptional()
  @IsIn(['Y', 'N'])
  commaFlag?: 'Y' | 'N';

  @ApiPropertyOptional({
    description: '품목구분 (0:원재료, 1:제품, 2:반제품, 3:상품, 4:부재료, 7:무형상품, 여러 개: ∬ 구분)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Matches(PROD_TYPE_PATTERN, { message: 'prodType 은 허용 코드(0,1,2,3,4,7)를 ∬ 로 연결한 형식만 허용됩니다.' })
  prodType?: string;

  @ApiPropertyOptional({ description: '품목코드 범위 시작 (최대 20자)' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  fromProdCd?: string;

  @ApiPropertyOptional({ description: '품목코드 범위 끝 (최대 20자)' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  toProdCd?: string;
}
