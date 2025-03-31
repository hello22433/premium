import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { OrderEventService } from '../application/order.event.service';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OrderEventGetListReqQueryDto, OrderEventSetLikeReqDto } from './order.event.req.dto';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { User } from '../../auth/api/user.decorator';
import { OrderEventResDto } from './order.event.res.dto';

@Controller('')
@ApiTags('order-event')
@ApiBearerAuth()
@UseGuards(AuthUserAuthorizationGuard)
export class OrderEventController {
  constructor(private orderEventService: OrderEventService) {}

  @ApiOperation({
    summary: '신규 주문 등록 이벤트 불러오기 API',
    description: '유저가 전송햇던 주문 list 기준으로 불러옵니다.<br>최고 관리자는 전체 이벤트를 불러올 수 있습니다.',
  })
  @ApiOkResponse({
    type: OrderEventResDto,
    description: '성공적으로 불러온 경우',
  })
  // ===========================================
  @Get('order-event/list')
  getList(@User() user: ILoginUserInfo, @Query() getQuery: OrderEventGetListReqQueryDto) {
    return this.orderEventService.getList(user, getQuery);
  }

  @ApiOperation({
    summary: '신규 주문 등록 이벤트 찜하기 API',
  })
  @ApiOkResponse({
    type: '',
    description: '',
  })
  // ===========================================
  @Post('order-event/like')
  setLike(@User() user: ILoginUserInfo, @Body() getBody: OrderEventSetLikeReqDto) {
    return this.orderEventService.setLike(user, getBody);
  }
}
