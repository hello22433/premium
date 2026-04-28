import {
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsEmail,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  Max,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EarlyDestroyRequestStatus } from '../../../entity/early.destroy.request.entity';

export class EarlyDestroyRequestMetaDto {
  @ApiPropertyOptional({ description: '고객사명' })
  @IsOptional()
  @IsString()
  clientCompany?: string;

  @ApiPropertyOptional({ description: '담당자명' })
  @IsOptional()
  @IsString()
  contactPerson?: string;

  @ApiPropertyOptional({ description: '담당자 이메일' })
  @IsOptional()
  @IsEmail()
  contactEmail?: string;

  @ApiPropertyOptional({ description: '판매전표 번호' })
  @IsOptional()
  @IsString()
  salesReceipt?: string;

  @ApiPropertyOptional({ description: '이벤트명' })
  @IsOptional()
  @IsString()
  eventName?: string;

  @ApiPropertyOptional({ description: '품목/수량 정보' })
  @IsOptional()
  @IsString()
  productInfo?: string;

  @ApiPropertyOptional({ description: '특이사항' })
  @IsOptional()
  @IsString()
  specialNotes?: string;

  @ApiPropertyOptional({ description: '완료 희망일시' })
  @IsOptional()
  @IsDateString()
  desiredCompletionDate?: string;

  @ApiPropertyOptional({ description: '참고사항' })
  @IsOptional()
  @IsString()
  referenceNotes?: string;
}

export class CreateEarlyDestroyRequestDto extends EarlyDestroyRequestMetaDto {
  @ApiProperty({ description: '대상 orderProductMapping ID 배열' })
  @IsArray()
  @IsNumber({}, { each: true })
  @IsNotEmpty()
  orderProductMappingIds: number[];
}

export class CreateWholeOrderEarlyDestroyRequestDto extends EarlyDestroyRequestMetaDto {}

export class CreateDeliveryEarlyDestroyRequestDto extends EarlyDestroyRequestMetaDto {
  @ApiProperty({ description: '대상 orderDelivery ID' })
  @IsInt()
  @IsNotEmpty()
  orderDeliveryId: number;
}

export class CreateDeliveriesEarlyDestroyRequestDto extends EarlyDestroyRequestMetaDto {
  @ApiProperty({ description: '대상 orderDelivery ID 배열' })
  @IsArray()
  @IsInt({ each: true })
  @ArrayNotEmpty()
  orderDeliveryIds: number[];
}

export class EarlyDestroyRequestViewDto {
  id: number;
  orderId: number;
  clientCompany: string | null;
  contactPerson: string | null;
  contactEmail: string | null;
  salesReceipt: string | null;
  eventName: string | null;
  productInfo: string | null;
  specialNotes: string | null;
  desiredCompletionDate: Date | null;
  referenceNotes: string | null;
  status: EarlyDestroyRequestStatus;
  requestedBy: number;
  requestedByEmail: string | null;
  requestedAt: Date;
  executedBy: number | null;
  executedByEmail: string | null;
  executedAt: Date | null;
  orderProductMappingIds: number[];
  orderDeliveryIds: number[];
}

export class UpdateDestroyPersonalInfoDayDto {
  @ApiProperty({ description: '변경할 개인정보파기 요청일 (일수)' })
  @IsNumber()
  @Min(1)
  @Max(3650)
  requestToDestroyPersonalInfoDay: number;
}
