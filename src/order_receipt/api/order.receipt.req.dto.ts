import { Type } from 'class-transformer';
import { PagingReqDto } from '../../common/api/dto/pagination.req.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsEnum, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';
import { OrderReceiptStatus } from '../interface/order.receipt.status';

export class OrderReceiptGetListReqQueryDto extends PagingReqDto {
  @ApiPropertyOptional({
    description: '상태 필터 ex) RECEIVED, REVIEWING, APPROVED, REJECTED',
  })
  // =================================
  @IsOptional()
  @IsIn(Object.values(OrderReceiptStatus))
  status?: OrderReceiptStatus;
}

export class OrderReceiptGetDetailReqParamDto {
  @ApiProperty({
    description: 'order_receipt id',
  })
  // =================================
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  id: number;
}

export class OrderReceiptCreateReqDto {
  @ApiProperty({
    description: '주문접수 제목',
  })
  // =================================
  @IsNotEmpty()
  @IsString()
  title: string;

  @ApiProperty({
    description: '첨부파일 url list',
  })
  // =================================
  @IsArray()
  filePath: string[];

  @ApiPropertyOptional({
    description: '요청사항',
  })
  // =================================
  @IsOptional()
  @IsString()
  requestNote?: string;
}

export class OrderReceiptRejectReqDto {
  @ApiProperty({
    description: '반려 사유',
  })
  // =================================
  @IsNotEmpty()
  @IsString()
  rejectReason: string;
}

export class OrderReceiptUpdateReqDto {
  @ApiPropertyOptional({
    description: '주문접수 제목 (기업관리자 본인, 접수 상태)',
  })
  // =================================
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional({
    description: '첨부파일 url list (기업관리자 본인, 접수 상태)',
  })
  // =================================
  @IsOptional()
  @IsArray()
  filePath?: string[];

  @ApiPropertyOptional({
    description: '요청사항 (기업관리자 본인, 접수 상태)',
  })
  // =================================
  @IsOptional()
  @IsString()
  requestNote?: string;

  @ApiPropertyOptional({
    description: '확인사항 (운영관리자 이상, 상태 무관)',
  })
  // =================================
  @IsOptional()
  @IsString()
  confirmNote?: string;

  @ApiPropertyOptional({
    description: '반려 사유 수정 (운영관리자 이상, 반려 상태)',
  })
  // =================================
  @IsOptional()
  @IsString()
  rejectReason?: string;
}

export class OrderReceiptChangeStatusReqDto {
  @ApiProperty({
    description: '변경할 상태 ex) RECEIVED, REVIEWING, APPROVED, REJECTED',
    enum: OrderReceiptStatus,
  })
  // =================================
  @IsNotEmpty()
  @IsEnum(OrderReceiptStatus)
  status: OrderReceiptStatus;
}
