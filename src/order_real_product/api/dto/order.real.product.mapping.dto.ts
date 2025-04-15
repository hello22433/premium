import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsOptional } from 'class-validator';

export class OrderRealProductMappingDto {
  @ApiProperty({
    description: '발주 번호 ) order real product mapping id ',
  })
  // ==================================
  @IsNotEmpty()
  @IsNumber()
  id: number;

  @ApiProperty({
    description: '작성자',
  })
  // ==================================
  @IsOptional()
  writer: string | null;

  @ApiProperty({
    description: '고객사 id',
  })
  // ==================================
  // @IsNotEmpty()
  // @IsNumber()
  userId: number;

  @ApiProperty({
    description: '협력사 id',
  })
  // ==================================
  @IsOptional()
  @IsNumber()
  partnerCompanyId: number | null;

  @ApiProperty({
    description: '구매 방법',
  })
  // ==================================
  @IsOptional()
  buyMethod: string | null;

  @ApiProperty({
    description: '현장 구매 장소',
  })
  // ==================================
  @IsOptional()
  offlineAddress: string | null;

  @ApiProperty({
    description: '현장 구매 담당자 명',
  })
  // ==================================
  @IsOptional()
  offlinePersonName: string | null;

  @ApiProperty({
    description: '현장 구매 담당자 연락처',
  })
  // ==================================
  @IsOptional()
  offlinePhoneNumber: string | null;

  @ApiProperty({
    description: '입고 방법',
  })
  // ==================================
  @IsOptional()
  receivingMethod: string | null;

  @ApiProperty({
    description: '운송장 번호',
  })
  // ==================================
  @IsNotEmpty()
  trackingNumber: string;

  @ApiProperty({
    description: '결제 방법',
  })
  // ==================================
  @IsOptional()
  paymentMethod: string | null;

  @ApiProperty({
    description: '특이사항',
  })
  // ==================================
  @IsOptional()
  remarks: string | null;

  @ApiProperty({
    description: '진행상태',
  })
  // ==================================
  @IsOptional()
  progressStatus: string | null;

  @ApiProperty({
    description: '첨부파일',
  })
  // ==================================
  @IsOptional()
  filePath: string | null;
}
