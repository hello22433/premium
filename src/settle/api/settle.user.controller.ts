import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { User } from '../../auth/api/user.decorator';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { SettleService } from '../application/settle.service';
import { SettleGetRemainServiceAmountResDto } from './settle.res.dto';

@Controller('')
@ApiTags('settle')
@ApiBearerAuth()
@UseGuards(AuthUserAuthorizationGuard)
export class SettleUserController {
  constructor(private settleService: SettleService) {}

  @ApiOperation({
    summary: '로그인한 사용자의 잔여 발송 한도 조회 API',
    description:
      '로그인한 사용자의 잔여 발송 한도를 조회합니다.<br>' +
      '공식: 잔여발송한도 = 최대서비스한도 - 발송금액(서비스금액 + 정산기일초과금액) + 정산금액',
  })
  @ApiOkResponse({
    type: SettleGetRemainServiceAmountResDto,
    description: '성공적으로 조회한 경우',
  })
  // =====================================
  @Get('settle/remain-service-amount')
  getRemainServiceAmount(@User() user: ILoginUserInfo) {
    return this.settleService.getRemainServiceAmount(user);
  }
}
