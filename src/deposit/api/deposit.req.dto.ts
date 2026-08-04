import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { PagingReqDto } from '../../common/api/dto/pagination.req.dto';
import { dateRegexp } from '../../common/domain/date.regexp';
import { DepositMatchStatus } from '../interface/deposit.match.status';
import { DepositTxType } from '../interface/deposit.tx.type';

/** 검색어 상한 = 대상 컬럼(varchar 191)의 길이. 그보다 긴 입력은 어차피 매칭될 수 없다. */
const DEPOSITOR_MAX_LENGTH = 191;
const ACCOUNT_NO_MAX_LENGTH = 50;

/**
 * 프론트 호환: 시각이 붙어 와도 날짜만 남긴다.
 *
 * 이 레포의 지배적 관례는 `yyyy-MM-ddTHH:mm:ss`(dateAtRegexp)이고, 정산관리 하위 화면들이
 * 기간 필터에 `T00:00:00` / `T23:59:59` 를 붙여 보낸다. 그런데 여기 대상 컬럼 tx_date 는
 * 시각이 없는 DATE 라 날짜만 필요하다.
 *
 * 관례를 따라 화면을 복붙하면 400 이 나는 상황을 막기 위해, 두 형식을 모두 받고 날짜만 취한다.
 * DATE 컬럼 비교라 `T23:59:59` 를 잘라도 종료일 포함 의미가 그대로 유지된다.
 * (검증은 자른 뒤 값에 걸리므로 엉뚱한 문자열은 여전히 거부된다)
 */
const toDateOnly = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.split('T')[0] : value);

export class DepositGetListReqQueryDto extends PagingReqDto {
  @ApiPropertyOptional({
    description: '거래일자 시작 (yyyy-MM-dd, 해당일 포함). yyyy-MM-ddTHH:mm:ss 로 보내면 날짜만 취한다',
    example: '2026-07-01',
  })
  // =============================================================
  @IsOptional()
  @Transform(toDateOnly)
  @Matches(dateRegexp, { message: 'startAt 은 yyyy-MM-dd 형식이어야 합니다.' })
  startAt?: string;

  @ApiPropertyOptional({
    description: '거래일자 종료 (yyyy-MM-dd, 해당일 포함). yyyy-MM-ddTHH:mm:ss 로 보내면 날짜만 취한다',
    example: '2026-07-31',
  })
  // =============================================================
  @IsOptional()
  @Transform(toDateOnly)
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
