import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Controller, Get, UseGuards } from '@nestjs/common';
import { SidebarService } from '../application/sidebar.service';
import { SidebarNotificationsResDto } from './sidebar.res.dto';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { User } from '../../auth/api/user.decorator';
import { ILoginUserInfo } from '../../auth/interface/login.user';

@ApiTags('sidebar')
@ApiBearerAuth()
@Controller('sidebar')
@UseGuards(AuthUserAuthorizationGuard)
export class SidebarController {
  constructor(private sidebarService: SidebarService) {}

  @ApiOperation({
    summary: '사이드바 알림 뱃지 카운트 조회 API',
    description: '사이드메뉴에 표시할 미처리 건수를 반환합니다. 프론트엔드에서 5분 간격 폴링으로 호출합니다.',
  })
  @ApiOkResponse({
    type: SidebarNotificationsResDto,
    description: '각 메뉴별 미처리 건수',
  })
  @Get('notifications')
  getNotificationCounts(@User() user: ILoginUserInfo) {
    return this.sidebarService.getNotificationCounts(user);
  }
}
