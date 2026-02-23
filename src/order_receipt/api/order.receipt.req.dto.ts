import { Type } from 'class-transformer';
import { PagingReqDto } from '../../common/api/dto/pagination.req.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';
import { OrderReceiptStatus } from '../interface/order.receipt.status';

export class OrderReceiptGetListReqQueryDto extends PagingReqDto {
  @ApiPropertyOptional({
    description: '상태 필터 ex) RECEIVED, APPROVED, REJECTED',
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
