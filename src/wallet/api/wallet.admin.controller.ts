import { Body, Controller, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { AuthUserSuperAndOperationAdminGuard } from '../../auth/api/auth.user.super-operation-admin.guard';
import { User } from '../../auth/api/user.decorator';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { WalletAccountResolverService } from '../application/wallet-account-resolver.service';
import { WalletLedgerService } from '../application/wallet-ledger.service';
import { CreditExcessApprovalService } from '../application/credit-excess-approval.service';
import { ApproveCreditExcessReqDto, IssueGrantReqDto, RejectCreditExcessReqDto } from './wallet.admin.req.dto';

@Controller('admin/wallet')
@UseGuards(AuthUserSuperAndOperationAdminGuard)
export class WalletAdminController {
  constructor(
    private readonly resolver: WalletAccountResolverService,
    private readonly ledger: WalletLedgerService,
    private readonly approval: CreditExcessApprovalService,
  ) {}

  @Post('grants')
  async issueGrant(@Body() dto: IssueGrantReqDto): Promise<{ grantId: string; isDuplicate: boolean }> {
    const wallet = await this.resolver.resolveBySettlementCode(dto.settlementCode);
    return this.ledger.issueGrant({
      walletAccountId: wallet.id,
      amount: dto.amount,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
      reason: dto.reason ?? null,
      idempotencyKey: dto.idempotencyKey,
    });
  }

  @Post('credit-excess-approval/:id/approve')
  async approveCreditExcess(
    @Param('id') id: string,
    @Body() _dto: ApproveCreditExcessReqDto,
    @User() user: ILoginUserInfo,
  ): Promise<{ status: string; approvedAt: Date | null }> {
    const approval = await this.approval.approve(id, user.id);
    return { status: approval.status, approvedAt: approval.approvedAt };
  }

  @Post('credit-excess-approval/:id/reject')
  async rejectCreditExcess(
    @Param('id') id: string,
    @Body() dto: RejectCreditExcessReqDto,
    @User() user: ILoginUserInfo,
  ): Promise<{ status: string; approvedAt: Date | null; rejectReason: string | null }> {
    const approval = await this.approval.reject(id, user.id, dto.rejectReason);
    return { status: approval.status, approvedAt: approval.approvedAt, rejectReason: approval.rejectReason };
  }
}
