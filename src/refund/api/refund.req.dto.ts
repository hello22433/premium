import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsNumber, IsOptional, Matches } from 'class-validator';
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
}

export class RefundUpdateReqDto {
  @ApiProperty({
    description: 'order delivery id',
  })
  // ==============================
  @IsNumber()
  @IsNotEmpty()
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
  @IsNotEmpty()
  bankName: string;

  @ApiProperty({
    description: '계좌번호',
  })
  // ==============================
  @IsNotEmpty()
  bankAccount: string;

  @ApiPropertyOptional({
    description: '예금주',
  })
  // ==============================
  @IsOptional()
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
