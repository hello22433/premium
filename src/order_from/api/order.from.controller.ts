import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { OrderFromService } from '../application/order.from.service';
import { ApiBadRequestResponse, ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { OrderFromGetEmailListResDto, OrderFromGetPhoneListResDto } from './order.from.res.dto';
import {
  OrderFromCreateEmailReqDto,
  OrderFromCreatePhoneReqDto,
  OrderFromGetPhoneReqQueryDto,
} from './order.from.req.dto';
import { User } from '../../auth/api/user.decorator';
import { ILoginUserInfo } from '../../auth/interface/login.user';

@ApiTags('order-from')
@ApiBearerAuth()
@UseGuards(AuthUserAuthorizationGuard)
@Controller('')
export class OrderFromController {
  constructor(private orderFromService: OrderFromService) {}

  @ApiOperation({
    summary: '발신 핸드폰 번호 리스트 불러오기',
  })
  @ApiOkResponse({
    type: OrderFromGetPhoneListResDto,
  })
  // ====================================================
  @Get('/order-from/phone/list')
  getPhoneList(@User() user: ILoginUserInfo, @Query() getQuery: OrderFromGetPhoneReqQueryDto) {
    return this.orderFromService.getPhoneList(user, getQuery);
  }

  @ApiOperation({
    summary: '발신 핸드폰 번호 추가하기',
  })
  @ApiOkResponse({
    description: '성공적으로 추가한 경우',
  })
  @ApiBadRequestResponse({
    description: '이미 등록된 발신번호가 존재할경우 <br>',
  })
  // ====================================================
  @Post('/order-from/phone')
  createPhone(@User() user: ILoginUserInfo, @Body() getBody: OrderFromCreatePhoneReqDto) {
    return this.orderFromService.createPhone(user, getBody);
  }

  @ApiOperation({
    summary: '발신 이메일 리스트 불러오기',
  })
  @ApiOkResponse({
    type: OrderFromGetEmailListResDto,
  })
  // ====================================================
  @Get('/order-from/email/list')
  getEmailList() {
    return this.orderFromService.getEmailList();
  }

  @ApiOperation({
    summary: '발신 이메일 추가하기',
  })
  @ApiOkResponse({
    description: '성공적으로 추가한 경우',
  })
  @ApiBadRequestResponse({
    description: '이미 등록된 이메일이 존재할경우 <br>' + '등록할 수 없는 이메일 id 일 경우',
  })
  // ====================================================
  @Post('/order-from/email')
  createEmail(@Body() getBody: OrderFromCreateEmailReqDto) {
    return this.orderFromService.createEmail(getBody);
  }
}
