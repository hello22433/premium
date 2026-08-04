import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DepositService } from '../application/deposit.service';
import { DepositSyncService } from '../application/deposit.sync.service';
import { DepositGetListReqQueryDto } from './deposit.req.dto';
import { DepositGetAccountListResDto, DepositGetListResDto, DepositGetSyncStatusResDto } from './deposit.res.dto';
import { AuthUserSuperAndOperationAdminGuard } from '../../auth/api/auth.user.super-operation-admin.guard';
import { AuthService } from '../../auth/application/auth.service';
import { User } from '../../auth/api/user.decorator';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';

/**
 * 입금내역 조회 API.
 *
 * 은행 계좌번호·예금주 실명·금액을 다루므로 고객사(CORPORATE_ADMIN)에게는 열지 않는다.
 * 가드로 사내 계정(SUPER/OPERATION_ADMIN)까지 좁힌 뒤, 서브메뉴 권한으로 담당자만 통과시킨다.
 */
@Controller('')
@ApiTags('deposit')
@ApiBearerAuth()
@UseGuards(AuthUserSuperAndOperationAdminGuard)
export class DepositController {
  constructor(
    private depositService: DepositService,
    private depositSyncService: DepositSyncService,
    private authService: AuthService,
  ) {}

  @ApiOperation({
    summary: '입금내역 목록 조회 API',
    description:
      'ECOUNT 입출금 거래내역(은행 원장) 조회. 금액은 은행 거래 사실이며 고객 예치금 잔액이 아니다.<br>' +
      '기본 정렬은 거래일자 최신순(동일 일자는 id 내림차순).',
  })
  @ApiOkResponse({
    type: DepositGetListResDto,
    description: '성공적으로 조회한 경우',
  })
  @Get('/deposit/list')
  async getList(
    @User() user: ILoginUserInfo,
    @Query() getQuery: DepositGetListReqQueryDto,
  ): Promise<DepositGetListResDto> {
    await this.authService.authorityValidator(user, UserAuthSubEnum.DEPOSIT_HISTORY);
    return this.depositService.getList(getQuery);
  }

  @ApiOperation({
    summary: '입금내역 계좌 목록 조회 API',
    description: '계좌 필터 드롭다운용. 실제 거래에 등장한 계좌를 건수 내림차순으로 반환한다.',
  })
  @ApiOkResponse({
    type: DepositGetAccountListResDto,
    description: '성공적으로 조회한 경우',
  })
  @Get('/deposit/accounts')
  async getAccountList(@User() user: ILoginUserInfo): Promise<DepositGetAccountListResDto> {
    await this.authService.authorityValidator(user, UserAuthSubEnum.DEPOSIT_HISTORY);
    return this.depositService.getAccountList();
  }

  @ApiOperation({
    summary: '입금내역 수집 상태 조회 API',
    description:
      '목록이 안 늘어날 때 "입금이 없는 것"인지 "수집이 멈춘 것"인지 구분하기 위한 신호.<br>' +
      'lastSyncedAt 은 항상 응답하고, source(스크래핑 서버 상태)는 닿지 못하면 null 이다.',
  })
  @ApiOkResponse({
    type: DepositGetSyncStatusResDto,
    description: '성공적으로 조회한 경우',
  })
  @Get('/deposit/sync-status')
  async getSyncStatus(@User() user: ILoginUserInfo): Promise<DepositGetSyncStatusResDto> {
    await this.authService.authorityValidator(user, UserAuthSubEnum.DEPOSIT_HISTORY);
    return this.depositSyncService.getSyncStatus();
  }
}
