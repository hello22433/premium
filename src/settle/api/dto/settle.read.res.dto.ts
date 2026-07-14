import { ApiProperty } from '@nestjs/swagger';

export class SettleAssignedUserDto {
  @ApiProperty({ description: 'user.id' })
  userId: number;

  @ApiProperty({ description: '담당자명 (user.personName)' })
  personName: string;
}

export class SettleSettlementCodeSnapshotDto {
  @ApiProperty({ description: '정산코드 (user.settlement_code)' })
  settlementCode: string;

  @ApiProperty({ description: 'wallet_account.id. 미존재 시 null', nullable: true })
  walletAccountId: string | null;

  @ApiProperty({
    description: 'ACTIVE | MISSING. MISSING = wallet 미생성(잔액0 아님, 데이터 누락 가능)',
    enum: ['ACTIVE', 'MISSING'],
  })
  walletStatus: 'ACTIVE' | 'MISSING';

  @ApiProperty({ description: '예치금 잔액' })
  depositBalance: number;

  @ApiProperty({ description: '여신 한도' })
  creditLimit: number;

  @ApiProperty({ description: '여신 사용액' })
  creditUsedAmount: number;

  @ApiProperty({ description: '신용초과 사용액' })
  creditExcessAmount: number;

  @ApiProperty({ description: '사용 가능 포인트 잔액 합 (만료/비활성 제외)' })
  pointTotalRemaining: number;

  @ApiProperty({
    description: '정산조건 (PRE_PAYMENT 선정산 / POST_PAYMENT 후정산). wallet 미존재 시 null',
    enum: ['PRE_PAYMENT', 'POST_PAYMENT'],
    nullable: true,
  })
  settleCondition: 'PRE_PAYMENT' | 'POST_PAYMENT' | null;

  @ApiProperty({
    description: '정산방법 (CARD 카드 / CASH 현금). wallet 미존재 시 null',
    enum: ['CARD', 'CASH'],
    nullable: true,
  })
  settleMethod: 'CARD' | 'CASH' | null;

  @ApiProperty({ description: '해당 정산코드 소속 user 목록', type: [SettleAssignedUserDto] })
  assignedUsers: SettleAssignedUserDto[];
}

export class SettleBySettlementCodeResDto {
  @ApiProperty({ description: 'user_company.id' })
  companyId: number;

  @ApiProperty({ description: '사업자명 (user_company.businessName)' })
  companyName: string;

  @ApiProperty({ description: '정산코드별 잔액 스냅샷. user 0명이면 빈 배열', type: [SettleSettlementCodeSnapshotDto] })
  settlementCodes: SettleSettlementCodeSnapshotDto[];
}

export class SettleSettlementCodeUsageDto {
  @ApiProperty({ description: '정산코드' })
  settlementCode: string;

  @ApiProperty({ description: 'wallet_account.id. 미존재 시 null', nullable: true })
  walletAccountId: string | null;

  @ApiProperty({ enum: ['ACTIVE', 'MISSING'] })
  walletStatus: 'ACTIVE' | 'MISSING';

  @ApiProperty({ description: 'Σ allocation.payableSettlementAmount. legacy "정산확정액"과 다른 지표 — 합산 금지' })
  walletPaidAmount: number;

  @ApiProperty({ description: 'Σ 예치금 사용액' })
  depositUsedAmount: number;

  @ApiProperty({ description: 'Σ 여신 사용액' })
  creditUsedAmount: number;

  @ApiProperty({ description: 'Σ 신용초과 사용액' })
  creditExcessAmount: number;

  @ApiProperty({ description: 'Σ 포인트 사용액' })
  pointUsedAmount: number;

  @ApiProperty({ description: '집계 대상 주문 수' })
  orderCount: number;
}

export class SettlePeriodDto {
  @ApiProperty({ description: 'YYYY-MM-DD' })
  from: string;

  @ApiProperty({ description: 'YYYY-MM-DD' })
  to: string;
}

export class SettleSettlementCodeUsageResDto {
  @ApiProperty()
  companyId: number;

  @ApiProperty({ description: '사업자명' })
  companyName: string;

  @ApiProperty({ type: SettlePeriodDto })
  period: SettlePeriodDto;

  @ApiProperty({
    description: '기간 기준 = allocation.createdAt(= wallet 차감/발송확정 시점). 주문 등록일/실발송일과 다른 축',
    enum: ['WALLET_DEDUCTED_AT'],
  })
  periodBasis: 'WALLET_DEDUCTED_AT';

  @ApiProperty({ description: '정산코드별 기간 wallet 결제액', type: [SettleSettlementCodeUsageDto] })
  settlementCodes: SettleSettlementCodeUsageDto[];
}
