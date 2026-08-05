import { ApiProperty } from '@nestjs/swagger';

export class CreditListRowDto {
  @ApiProperty() partnerCompanyId: number;
  @ApiProperty() partnerType: string;
  @ApiProperty() partnerName: string;
  @ApiProperty() subItemKey: string;
  @ApiProperty() monthlyLimit: string;
  @ApiProperty({ nullable: true, description: '미정산 정가 합계. SSG 는 null(§4.3 예외)' })
  unsettledBaseAmount: string | null;
  @ApiProperty() previousMonthBaseAmount: string;
  @ApiProperty({ nullable: true, description: 'fail-closed 또는 미연동 시 null' })
  availableBalance: string | null;
  @ApiProperty({ enum: ['AVAILABLE', 'NOT_AVAILABLE', 'FAILED'] })
  balanceSourceStatus: string;
  @ApiProperty({ enum: ['OK', 'NEEDS_REVIEW'] })
  creditDataStatus: string;
  @ApiProperty() reviewCount: number;
  @ApiProperty() reviewBaseAmount: string;
  @ApiProperty() orphanPendingCount: number;
  @ApiProperty({ description: '갤럭시아 롯데 기본 숨김 + 미정산≠0 또는 전월≠0 자동 재표시' })
  hidden: boolean;
}

export class CreditListPaymentVarianceRowDto {
  @ApiProperty() partnerCompanyId: number;
  @ApiProperty() partnerType: string;
  @ApiProperty({ example: 'PAYMENT_VARIANCE' }) subItemKey: string;
  @ApiProperty() paymentVarianceAdjustmentAmount: string;
  @ApiProperty({ type: String, nullable: true }) monthlyLimit: null;
  @ApiProperty({ type: String, nullable: true }) availableBalance: null;
}

export class CreditListResDto {
  @ApiProperty({ type: [CreditListRowDto] })
  rows: CreditListRowDto[];
  @ApiProperty({ type: [CreditListPaymentVarianceRowDto] })
  paymentVarianceRows: CreditListPaymentVarianceRowDto[];
}
