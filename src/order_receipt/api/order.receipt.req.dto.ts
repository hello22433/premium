import { Type } from 'class-transformer';
import { PagingReqDto } from '../../common/api/dto/pagination.req.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsEnum, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';
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

export class OrderReceiptFileDownloadReqQueryDto {
  @ApiProperty({
    description: '다운로드할 첨부파일 url (해당 주문접수에 첨부된 url 이어야 함)',
  })
  // =================================
  @IsNotEmpty()
  @IsString()
  fileUrl: string;
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
  @ArrayMaxSize(10, { message: '첨부파일은 최대 10개까지 등록할 수 있습니다.' })
  @IsString({ each: true })
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
  @ArrayMaxSize(10, { message: '첨부파일은 최대 10개까지 등록할 수 있습니다.' })
  @IsString({ each: true })
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
