import { IsArray, IsDateString, IsEmail, IsNotEmpty, IsNumber, IsOptional, IsString, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EarlyDestroyRequestStatus } from '../../../entity/early.destroy.request.entity';

// 조기파기 요청 등록
export class CreateEarlyDestroyRequestDto {
  @ApiProperty({ description: '대상 orderProductMapping ID 배열' })
  @IsArray()
  @IsNumber({}, { each: true })
  @IsNotEmpty()
  orderProductMappingIds: number[];

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

// 조기파기 요청 응답
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
}

// 파기일 변경
export class UpdateDestroyPersonalInfoDayDto {
  @ApiProperty({ description: '변경할 개인정보파기 요청일 (일수)' })
  @IsNumber()
  @Min(1)
  @Max(3650)
  requestToDestroyPersonalInfoDay: number;
}
