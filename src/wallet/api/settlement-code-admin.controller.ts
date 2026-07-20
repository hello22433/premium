import { BadRequestException, Body, Controller, Get, ParseIntPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';

import { User } from '../../auth/api/user.decorator';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { AuthUserSuperAndOperationAdminGuard } from '../../auth/api/auth.user.super-operation-admin.guard';
import {
  WalletReadService,
  SettlementCodeSnapshot,
  SettlementCodeDetail,
  SettlementCodeSearchResult,
} from '../application/wallet-read.service';
import { SettlementCodeAdminService, SettlementCodeHistoryEventType } from '../application/settlement-code-admin.service';

/** query 문자열 → 선택적 정수(빈값 undefined, 비정수 400). */
function parseOptionalInt(v: string | undefined, field: string): number | undefined {
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) {
    throw new BadRequestException(`${field} 은(는) 정수여야 합니다.`);
  }
  return n;
}

class IssueCodeReqDto {
  @IsInt()
  @Min(1)
  userId: number;
}

class AssignCodeReqDto {
  @IsInt()
  @Min(1)
  userId: number;

  @IsString()
  @IsNotEmpty()
  settlementCode: string;
}

class RenameCodeReqDto {
  @IsInt()
  @Min(1)
  companyId: number;

  @IsString()
  @IsNotEmpty()
  oldCode: string;

  @IsString()
  @IsNotEmpty()
  newCode: string;
}

class SetCreditLimitReqDto {
  @IsString()
  @IsNotEmpty()
  settlementCode: string;

  @IsInt()
  @Min(0)
  creditLimit: number;
}

class SetSettlePolicyReqDto {
  @IsString()
  @IsNotEmpty()
  settlementCode: string;

  @IsOptional()
  @IsIn(['PRE_PAYMENT', 'POST_PAYMENT'])
  settleCondition?: 'PRE_PAYMENT' | 'POST_PAYMENT';

  @IsOptional()
  @IsIn(['CARD', 'CASH'])
  settleMethod?: 'CARD' | 'CASH';
}

class ChargeDepositReqDto {
  @IsString()
  @IsNotEmpty()
  settlementCode: string;

  @IsInt()
  @Min(1)
  chargeAmount: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  memo?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  requestKey: string;
}

/**
 * settlement_code(정산코드) 운영자 관리 API (plan PR-C, Top-1).
 *
 * 권한: SUPER_ADMIN / OPERATION_ADMIN (AuthUserSuperAndOperationAdminGuard). CORPORATE_ADMIN 은 접근 불가.
 * 조회는 WalletReadService.getSettlementCodeSnapshot 재사용, mutation 은 SettlementCodeAdminService 위임.
 */
@ApiBearerAuth()
@ApiTags('settlement-codes')
@Controller('settlement-codes')
@UseGuards(AuthUserSuperAndOperationAdminGuard)
export class SettlementCodeAdminController {
  constructor(
    private readonly walletReadService: WalletReadService,
    private readonly adminService: SettlementCodeAdminService,
  ) {}

  /** 회사의 정산코드별 현재 wallet 잔액/포인트 + 배정 사용자 스냅샷. */
  @Get()
  @ApiOperation({ summary: '정산코드 목록/스냅샷 조회 (회사 단위)' })
  list(@Query('companyId', new ParseIntPipe()) companyId: number) {
    return this.walletReadService.getSettlementCodeSnapshot(companyId);
  }

  /** 정산코드 검색 (필터·커서 페이지네이션, 회사 선택적 — 회사 선택 강제 완화). */
  @Get('search')
  @ApiOperation({ summary: '정산코드 검색 (선/후정산·정산방법·예치금/여신 범위·코드검색, 회사 선택적)' })
  search(
    @Query('companyId') companyId?: string,
    @Query('settleCondition') settleCondition?: string,
    @Query('settleMethod') settleMethod?: string,
    @Query('depositMin') depositMin?: string,
    @Query('depositMax') depositMax?: string,
    @Query('creditLimitMin') creditLimitMin?: string,
    @Query('creditLimitMax') creditLimitMax?: string,
    @Query('codeQuery') codeQuery?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<SettlementCodeSearchResult> {
    return this.walletReadService.searchSettlementCodes({
      companyId: parseOptionalInt(companyId, 'companyId'),
      settleCondition: settleCondition as 'PRE_PAYMENT' | 'POST_PAYMENT' | undefined,
      settleMethod: settleMethod as 'CARD' | 'CASH' | undefined,
      depositMin: parseOptionalInt(depositMin, 'depositMin'),
      depositMax: parseOptionalInt(depositMax, 'depositMax'),
      creditLimitMin: parseOptionalInt(creditLimitMin, 'creditLimitMin'),
      creditLimitMax: parseOptionalInt(creditLimitMax, 'creditLimitMax'),
      codeQuery,
      limit: parseOptionalInt(limit, 'limit'),
      cursor,
    });
  }

  /** 정산코드 키 단위 상세 (정책 + 잔액 + 배정 계정, 회사 걸침 포함 — N:M). */
  @Get('detail')
  @ApiOperation({ summary: '정산코드 상세 조회 (정책/잔액/배정 계정)' })
  detail(@Query('settlementCode') settlementCode: string): Promise<SettlementCodeDetail> {
    return this.walletReadService.getSettlementCodeDetail(settlementCode);
  }

  /** 정산코드 정책/여신한도 변경 이력 (activity_log, cursor pagination). 예치금은 GET /deposits. */
  @Get('history')
  @ApiOperation({ summary: '정산코드 정책/여신한도 변경 이력 조회' })
  history(
    @Query('settlementCode') settlementCode: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('eventType') eventType?: SettlementCodeHistoryEventType,
  ) {
    return this.adminService.getCodeHistory(settlementCode, {
      limit: limit !== undefined ? Number(limit) : undefined,
      cursor,
      eventType,
    });
  }

  /** 정산코드 예치금 충전 이력 (wallet_transaction 정본, cursor pagination). */
  @Get('deposits')
  @ApiOperation({ summary: '정산코드 예치금 충전 이력 조회' })
  depositHistory(
    @Query('settlementCode') settlementCode: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.adminService.getDepositHistory(settlementCode, {
      limit: limit !== undefined ? Number(limit) : undefined,
      cursor,
    });
  }

  /** 정산코드 단위 정산조건/정산방법 변경 (정산조건 변경 시 진행중 주문 게이트). */
  @Put('settle-policy')
  @ApiOperation({ summary: '정산코드 정산조건/정산방법 변경' })
  setSettlePolicy(@User() user: ILoginUserInfo, @Body() body: SetSettlePolicyReqDto) {
    return this.adminService.setSettlePolicy(
      body.settlementCode,
      { settleCondition: body.settleCondition, settleMethod: body.settleMethod },
      user,
    );
  }

  /** 정산코드 단위 예치금 충전 (누적 충전 이벤트 생성). */
  @Post('deposits')
  @ApiOperation({ summary: '정산코드 예치금 충전' })
  deposit(@User() user: ILoginUserInfo, @Body() body: ChargeDepositReqDto) {
    return this.adminService.chargeDeposit(
      body.settlementCode,
      body.chargeAmount,
      user,
      body.memo,
      body.requestKey,
    );
  }

  /** 특정 정산코드에 배정된 계정 목록 (스냅샷에서 필터). */
  @Get('accounts')
  @ApiOperation({ summary: '정산코드에 배정된 계정 목록' })
  async accounts(
    @Query('companyId', new ParseIntPipe()) companyId: number,
    @Query('settlementCode') settlementCode: string,
  ): Promise<SettlementCodeSnapshot> {
    if (!settlementCode || settlementCode.trim() === '') {
      throw new BadRequestException('settlementCode 는 필수입니다.');
    }
    const snapshot = await this.walletReadService.getSettlementCodeSnapshot(companyId);
    const found = snapshot.settlementCodes.find((c) => c.settlementCode === settlementCode);
    if (!found) {
      throw new BadRequestException(`정산코드('${settlementCode}')를 이 회사에서 찾을 수 없습니다.`);
    }
    return found;
  }

  /** 정산코드 배정 대기(PENDING) 계정 목록 (settlement_code 미배정 활성 사용자). */
  @Get('pending')
  @ApiOperation({ summary: '정산코드 배정 대기 계정 목록 (회사 단위)' })
  pending(@Query('companyId', new ParseIntPipe()) companyId: number) {
    return this.adminService.listPendingAccounts(companyId);
  }

  /** 사용자에게 신규 정산코드 발급. */
  @Post('issue')
  @ApiOperation({ summary: '정산코드 신규 발급 (company-{id}-{n})' })
  async issue(@Body() body: IssueCodeReqDto): Promise<{ settlementCode: string }> {
    const settlementCode = await this.adminService.issueNewCode(body.userId);
    return { settlementCode };
  }

  /** 사용자를 회사의 기존 정산코드로 재배정. */
  @Put('assign')
  @ApiOperation({ summary: '정산코드 재배정 (기존 코드로)' })
  async assign(@Body() body: AssignCodeReqDto): Promise<{ success: true }> {
    await this.adminService.assignUserToCode(body.userId, body.settlementCode);
    return { success: true };
  }

  /** 정산코드 리네임 (wallet owner_id + 모든 참조 user.settlement_code). */
  @Put('rename')
  @ApiOperation({ summary: '정산코드 리네임' })
  async rename(@User() user: ILoginUserInfo, @Body() body: RenameCodeReqDto): Promise<{ success: true }> {
    await this.adminService.renameCode(body.companyId, body.oldCode, body.newCode, user);
    return { success: true };
  }

  /** 정산코드 단위 여신 한도 설정 (per-code creditLimit SoT). */
  @Put('credit-limit')
  @ApiOperation({ summary: '정산코드 여신 한도 설정' })
  async setCreditLimit(@User() user: ILoginUserInfo, @Body() body: SetCreditLimitReqDto) {
    return this.adminService.setCodeCreditLimit(body.settlementCode, body.creditLimit, user);
  }
}
