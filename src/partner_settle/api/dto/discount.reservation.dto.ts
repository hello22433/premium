import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { IUserDiscountCategory } from '../../../user_discount/interface/user.discount.category';
import { IUserDiscountMethod } from '../../../user_discount/interface/user.discount.method';
import { ICompareCondition } from '../../../user_discount/interface/compare.condition';
import { IPriceAdjustment } from '../../../user_discount/interface/price.adjustment';
import { IPartnerDiscountReservationStatus } from '../../interface/partner.discount.reservation.status';

export class ReservationQueryDto {
  @ApiPropertyOptional({ description: '상태 필터', enum: ['PENDING', 'APPLIED', 'CANCELED', 'BLOCKED'] })
  @IsOptional()
  @IsIn(['PENDING', 'APPLIED', 'CANCELED', 'BLOCKED'])
  status?: IPartnerDiscountReservationStatus;

  @ApiPropertyOptional({ description: '협력사 id' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  partnerCompanyId?: number;

  @ApiPropertyOptional({ description: 'canonical scopeKey (sk1|...)' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  scopeKey?: string;

  @ApiPropertyOptional({ description: '페이지 크기 (기본 50, 최대 200)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ description: '건너뛸 건수' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

/**
 * 예약 생성 요청.
 *
 * `pricePercent` 상한은 DB CHECK(DISCOUNT 100 · ADDITIONAL 1000)와 같은 절대 상한만 여기서 막는다.
 * 더 좁은 실무 상한은 env 라 DB CHECK 로 참조할 수 없어 서비스에서 별도로 다룬다.
 */
export class ReservationCreateReqDto {
  @ApiProperty({ description: '협력사 id' })
  @Type(() => Number)
  @IsInt()
  partnerCompanyId: number;

  @ApiProperty({ description: '할인 분류', enum: IUserDiscountCategory })
  @IsEnum(IUserDiscountCategory)
  category: IUserDiscountCategory;

  @ApiPropertyOptional({ description: 'FK) classification.id' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  classificationId?: number | null;

  @ApiProperty({ description: '할인 방법', enum: IUserDiscountMethod })
  @IsEnum(IUserDiscountMethod)
  method: IUserDiscountMethod;

  @ApiPropertyOptional({ description: '브랜드' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  primaryCategory?: string | null;

  @ApiPropertyOptional({ description: '상품군' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  group?: string | null;

  @ApiPropertyOptional({ description: '구간' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  range?: string | null;

  @ApiProperty({ description: '비교 조건', enum: ICompareCondition })
  @IsEnum(ICompareCondition)
  compareCondition: ICompareCondition;

  @ApiProperty({ description: '예약할 수수료 (percent)' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1000)
  pricePercent: number;

  @ApiProperty({ description: '가격 조정 방향', enum: IPriceAdjustment })
  @IsEnum(IPriceAdjustment)
  priceAdjustment: IPriceAdjustment;

  @ApiProperty({ description: '적용 시각 (ISO8601). 과거 지정은 소급 예약이며 별도 flag 가 필요하다' })
  @IsDateString()
  effectiveAt: string;

  @ApiProperty({ description: '생성 멱등 키 (필수). 응답 유실 재시도 시 같은 키로 다시 부른다' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  requestKey: string;
}
