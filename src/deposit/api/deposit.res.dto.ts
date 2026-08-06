import { ApiProperty } from '@nestjs/swagger';
import { DepositMatchStatus } from '../interface/deposit.match.status';
import { DepositTxType } from '../interface/deposit.tx.type';

export class DepositViewDto {
  @ApiProperty({ description: '입금내역 id' })
  id: number;

  @ApiProperty({ description: '거래 일자 (yyyy-MM-dd)', example: '2026-07-29' })
  txDate: string;

  @ApiProperty({
    description: '구분 (DEPOSIT/WITHDRAW). 스크래핑 원문이 예상 밖이면 null',
    enum: DepositTxType,
    nullable: true,
  })
  txType: DepositTxType | null;

  @ApiProperty({ description: '구분 원문 (ECOUNT 표기 그대로)', example: '입금' })
  txTypeLabel: string;

  @ApiProperty({ description: '계좌번호 (마스킹형)', example: '280***01757104' })
  accountNo: string;

  @ApiProperty({ description: '계좌명 (ECOUNT 표기. 은행명/회사명이 섞여 있어 식별자로 쓰지 말 것)', nullable: true })
  accountName: string | null;

  @ApiProperty({ description: '입금처 ((가상) 접두 제거본)' })
  depositor: string;

  @ApiProperty({ description: '입금처 원문 (툴팁용)', nullable: true })
  depositorRaw: string | null;

  @ApiProperty({ description: 'ECOUNT 거래처코드', nullable: true })
  erpPartnerCode: string | null;

  @ApiProperty({ description: 'ECOUNT 거래처명', nullable: true })
  erpPartnerName: string | null;

  @ApiProperty({ description: '금액(원)' })
  amount: number;

  @ApiProperty({ description: '거래후 잔액(원)' })
  balance: number;

  @ApiProperty({ description: '회계전표번호 (숫자가 아닐 수 있음. 문자열 그대로 표시)', nullable: true })
  voucherNo: string | null;

  @ApiProperty({ description: '매칭 상태', enum: DepositMatchStatus })
  matchStatus: string;

  @ApiProperty({
    description: '매칭된 예치금 지갑의 주인 타입 (현재 SETTLEMENT_CODE 단일. 미매칭이면 null)',
    nullable: true,
  })
  matchedOwnerType: string | null;

  @ApiProperty({
    description: '매칭된 지갑 주인의 식별자 (SETTLEMENT_CODE 면 정산코드. 미매칭이면 null)',
    nullable: true,
  })
  matchedOwnerId: string | null;

  @ApiProperty({
    description: '매칭 대상 표시명 (정산코드면 홈 회사명). 미매칭이거나 이름을 못 찾으면 null',
    nullable: true,
  })
  matchedOwnerName: string | null;

  @ApiProperty({ description: '스크래핑 시각' })
  scrapedAt: Date;
}

export class DepositGetListResDto {
  @ApiProperty({ type: [DepositViewDto], description: '입금내역 목록' })
  list: DepositViewDto[];

  @ApiProperty({ description: '전체 개수' })
  totalCount: number;

  @ApiProperty({ description: '전체 페이지 수' })
  totalPage: number;

  @ApiProperty({ description: '현재 페이지' })
  currentPage: number;
}

export class DepositAccountViewDto {
  @ApiProperty({ description: '계좌번호 (마스킹형)', example: '280***01757104' })
  accountNo: string;

  @ApiProperty({ description: '계좌명 (ECOUNT 표기)', nullable: true })
  accountName: string | null;

  @ApiProperty({ description: '해당 계좌의 거래 건수' })
  count: number;
}

export class DepositGetAccountListResDto {
  @ApiProperty({ type: [DepositAccountViewDto], description: '계좌 목록 (건수 내림차순)' })
  accounts: DepositAccountViewDto[];
}

export class DepositSourceStatusViewDto {
  @ApiProperty({ description: 'erp_macro 수집이 차단된 상태인지' })
  gateTripped: boolean;

  @ApiProperty({ description: '차단 사유', nullable: true })
  gateReason: string | null;

  @ApiProperty({
    description: 'erp_macro 의 폴링이 마지막으로 성공 완료된 시각 (개별 행의 스크래핑 시각이 아님)',
    nullable: true,
  })
  lastScrapedAt: string | null;

  @ApiProperty({
    description: '상대 폴링 스위치 상태. lastScrapedAt=null 이 "꺼둠"인지 "아직 미실행"인지 구분용. 미지원이면 null',
    nullable: true,
  })
  pollingEnabled: boolean | null;
}

export class DepositGetSyncStatusResDto {
  @ApiProperty({ description: '동기화 배치 활성 여부' })
  enabled: boolean;

  @ApiProperty({
    description: '프리미엄이 마지막으로 데이터를 받아온 시각. 오래됐다면 동기화가 멈춘 것',
    nullable: true,
  })
  lastSyncedAt: Date | null;

  @ApiProperty({
    type: DepositSourceStatusViewDto,
    description: 'erp_macro 쪽 수집 상태. 스크래핑 서버에 닿지 못하면 null (화면은 계속 동작)',
    nullable: true,
  })
  source: DepositSourceStatusViewDto | null;
}
