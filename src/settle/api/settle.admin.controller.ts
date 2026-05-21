import { Controller, Get, Param, ParseIntPipe, UseGuards } from '@nestjs/common';
import { AuthUserSuperAndOperationAdminGuard } from '../../auth/api/auth.user.super-operation-admin.guard';
import { SettleAdminReadService, SettleByCompanyView } from '../application/settle.admin-read.service';

/**
 * PR4 — 고객사별정산관리 settlement_code 단위 분리 표시.
 */
@Controller('admin/settle')
@UseGuards(AuthUserSuperAndOperationAdminGuard)
export class SettleAdminController {
  constructor(private readonly readService: SettleAdminReadService) {}

  @Get('by-settlement-code/:companyId')
  async byCompany(@Param('companyId', ParseIntPipe) companyId: number): Promise<SettleByCompanyView> {
    return this.readService.getByCompany(companyId);
  }
}
