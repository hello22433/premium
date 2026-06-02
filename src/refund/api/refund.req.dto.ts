import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { dateAtRegexp } from '../../common/domain/date.regexp';
import { OrderDeliveryRefundStatusEnum } from '../../delivery/interface/order.delivery.refund.status.enum';
import { PagingReqDto } from '../../common/api/dto/pagination.req.dto';

export class RefundGetListReqQueryDto extends PagingReqDto {
  @ApiPropertyOptional({
    description: '조회 시작기간',
  })
  // ==============================
  @IsOptional()
  @Matches(dateAtRegexp)
  startAt?: string;

  @ApiPropertyOptional({
    description: '조회 종료기간',
  })
  // ==============================
  @IsOptional()
  @Matches(dateAtRegexp)
  endAt?: string;

  @ApiPropertyOptional({
    description: '고객사명',
  })
  // ==============================
  @IsOptional()
  userBusinessName?: string;

  @ApiPropertyOptional({
    description: '담당자 명',
  })
  // ==============================
  @IsOptional()
  userPersonName?: string;

  @ApiPropertyOptional({
    description: '환불 상태',
  })
  // ==============================
  @IsOptional()
  @IsEnum(OrderDeliveryRefundStatusEnum)
  refundStatus?: OrderDeliveryRefundStatusEnum;

  @ApiPropertyOptional({
    description: '수신정보 검색 키워드 (전화번호 또는 이메일). 정규화 후 정확 일치 검색',
    example: '01012345678',
  })
  // ==============================
  @IsOptional()
  @IsString()
  deliveryTarget?: string;
}

export class RefundUpdateReqDto {
  @ApiProperty({
    description: 'order delivery id',
  })
  // ==============================
  @IsInt()
  @IsPositive()
  id: number;

  @ApiProperty({
    description: 'PROGRESS: 진행중, APPROVE: 승인, COMPLETE: 환불 완료',
  })
  // ==============================
  @IsEnum(OrderDeliveryRefundStatusEnum)
  @IsNotEmpty()
  refundStatus: OrderDeliveryRefundStatusEnum;

  @ApiProperty({
    description: '은행 명',
  })
  // ==============================
  @IsString()
  @IsNotEmpty()
  bankName: string;

  @ApiProperty({
    description: '계좌번호',
  })
  // ==============================
  @IsString()
  @IsNotEmpty()
  bankAccount: string;

  @ApiPropertyOptional({
    description: '예금주',
  })
  // ==============================
  @IsOptional()
  @IsString()
  bankAccountOwner?: string;

  @ApiPropertyOptional({
    description: '승인일자',
  })
  // ==============================
  @IsOptional()
  @Matches(dateAtRegexp)
  approveAt?: string;

  @ApiPropertyOptional({
    description: '환불일자',
  })
  // ==============================
  @IsOptional()
  @Matches(dateAtRegexp)
  refundAt?: string;
}

export class RefundResetReqDto {
  @ApiProperty({
    description: 'order delivery id',
  })
  // ==============================
  @IsInt()
  @IsPositive()
  id: number;
}

export class RefundResetBatchReqDto {
  @ApiProperty({
    description: '일괄 초기화할 order delivery id 배열 (하나라도 실패 시 전체 롤백)',
    example: [1, 2, 3],
  })
  // ==============================
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsInt({ each: true })
  @IsPositive({ each: true })
  @Type(() => Number)
  ids: number[];
}

export class RefundUpdateBatchReqDto {
  @ApiProperty({
    description: '일괄 저장할 환불 항목 배열 (하나라도 실패 시 전체 롤백)',
    type: [RefundUpdateReqDto],
  })
  // ==============================
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => RefundUpdateReqDto)
  items: RefundUpdateReqDto[];
}
