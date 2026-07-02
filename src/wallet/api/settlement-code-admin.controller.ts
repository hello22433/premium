import { BadRequestException, Body, Controller, Get, ParseIntPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsString, Min } from 'class-validator';

import { User } from '../../auth/api/user.decorator';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { AuthUserSuperAndOperationAdminGuard } from '../../auth/api/auth.user.super-operation-admin.guard';
import { WalletReadService, SettlementCodeSnapshot } from '../application/wallet-read.service';
import { SettlementCodeAdminService } from '../application/settlement-code-admin.service';

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
  async rename(@Body() body: RenameCodeReqDto): Promise<{ success: true }> {
    await this.adminService.renameCode(body.companyId, body.oldCode, body.newCode);
    return { success: true };
  }

  /** 정산코드 단위 여신 한도 설정 (per-code creditLimit SoT). */
  @Put('credit-limit')
  @ApiOperation({ summary: '정산코드 여신 한도 설정' })
  async setCreditLimit(@User() user: ILoginUserInfo, @Body() body: SetCreditLimitReqDto) {
    return this.adminService.setCodeCreditLimit(body.settlementCode, body.creditLimit, user);
  }
}
