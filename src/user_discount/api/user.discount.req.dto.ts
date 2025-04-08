import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsNumber, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';
import { PagingReqDto } from '../../common/api/dto/pagination.req.dto';
import { IUserDiscountCategory } from '../interface/user.discount.category';
import { IPriceAdjustment } from '../interface/price.adjustment';
import { ICompareCondition } from '../interface/compare.condition';
import { IUserDiscountMethod } from '../interface/user.discount.method';

export class UserDiscountGetListReqDto extends PagingReqDto {
  @ApiPropertyOptional({
    description: '조회하고자 하는 유저 id',
  })
  // =============================================================
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  userId?: number;

  @ApiPropertyOptional({
    description: '조회하고자 하는 협력사 id',
  })
  // =============================================================
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  partnerCompanyId?: number;
}

export class UserDiscountCreateReqDto {
  @ApiPropertyOptional({
    description: '할인 적용하고자 하는 유저 id',
  })
  // =============================================================
  @IsOptional()
  @IsNumber()
  userId?: number;

  @ApiPropertyOptional({
    description: '할인 적용하고자 하는 협력사 id',
  })
  // =============================================================
  @IsOptional()
  @IsNumber()
  partnerCompanyId?: number;

  @ApiProperty({
    description: '할인 분류 ex) 상품군: CATEGORY, 대분류: CLASSIFICATION',
  })
  // =============================================================
  @IsNotEmpty()
  @IsEnum(IUserDiscountCategory)
  category: IUserDiscountCategory;

  @ApiProperty({
    description: '할인 방법 ex) 구간: SECTION, 일괄: BULK',
  })
  // =============================================================
  @IsEnum(IUserDiscountMethod)
  method: IUserDiscountMethod;

  @ApiPropertyOptional({
    description: '대분류',
  })
  // =============================================================
  @IsOptional()
  primaryCategory: string | null;

  @ApiPropertyOptional({
    description: '상품군',
  })
  // =============================================================
  @IsOptional()
  group: string | null;

  @ApiPropertyOptional({
    description: '구간',
  })
  // =============================================================
  @IsOptional()
  range: string | null;

  @ApiProperty({
    description: '비교조건 ex) MORE_THAN: 초과, MORE: 이상, LESS_THAN: 미만, LESS: 이하',
  })
  // =============================================================
  @IsNotEmpty()
  @IsEnum(ICompareCondition)
  compareCondition: ICompareCondition;

  @ApiProperty({
    description: '할인/할증',
  })
  // =============================================================
  @IsNotEmpty()
  @IsEnum(IPriceAdjustment)
  priceAdjustment: IPriceAdjustment;

  @ApiProperty({
    description: '적용수수료(%)',
  })
  // =============================================================
  @IsNumber()
  @IsNotEmpty()
  pricePercent: number;
}

export class UserDiscountDeleteReqDto {
  @ApiProperty({
    description: '삭제할 id',
  })
  // =============================================================
  @IsNumber()
  @IsNotEmpty()
  id: number;
}
