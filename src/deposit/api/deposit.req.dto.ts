import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { PagingReqDto } from '../../common/api/dto/pagination.req.dto';
import { dateRegexp } from '../../common/domain/date.regexp';
import { DepositMatchStatus } from '../interface/deposit.match.status';
import { DepositTxType } from '../interface/deposit.tx.type';

/** 검색어 상한 = 대상 컬럼(varchar 191)의 길이. 그보다 긴 입력은 어차피 매칭될 수 없다. */
const DEPOSITOR_MAX_LENGTH = 191;
const ACCOUNT_NO_MAX_LENGTH = 50;

export class DepositGetListReqQueryDto extends PagingReqDto {
  @ApiPropertyOptional({
    description: '거래일자 시작 (yyyy-MM-dd, 해당일 포함)',
    example: '2026-07-01',
  })
  // =============================================================
  @IsOptional()
  @Matches(dateRegexp, { message: 'startAt 은 yyyy-MM-dd 형식이어야 합니다.' })
  startAt?: string;

  @ApiPropertyOptional({
    description: '거래일자 종료 (yyyy-MM-dd, 해당일 포함)',
    example: '2026-07-31',
  })
  // =============================================================
  @IsOptional()
  @Matches(dateRegexp, { message: 'endAt 은 yyyy-MM-dd 형식이어야 합니다.' })
  endAt?: string;

  @ApiPropertyOptional({
    description: '구분 ex) 입금: DEPOSIT, 출금: WITHDRAW',
    enum: DepositTxType,
  })
  // =============================================================
  @IsOptional()
  @IsEnum(DepositTxType)
  txType?: DepositTxType;

  @ApiPropertyOptional({
    description: '매칭 상태 ex) UNMATCHED, MAPPED, AMBIGUOUS, CREDITED',
    enum: DepositMatchStatus,
  })
  // =============================================================
  @IsOptional()
  @IsEnum(DepositMatchStatus)
  matchStatus?: DepositMatchStatus;

  @ApiPropertyOptional({
    description: '입금처 검색어 (부분 일치)',
  })
  // =============================================================
  @IsOptional()
  @IsString()
  @MaxLength(DEPOSITOR_MAX_LENGTH)
  depositor?: string;

  @ApiPropertyOptional({
    description: '계좌번호 (마스킹형 전체 일치. 목록은 /deposit/accounts 에서 조회)',
    example: '280***01757104',
  })
  // =============================================================
  @IsOptional()
  @IsString()
  @MaxLength(ACCOUNT_NO_MAX_LENGTH)
  accountNo?: string;
}
