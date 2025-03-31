import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import {
  OrderReceiveAlimTalkReqDto,
  OrderReceiveEmailReqDto,
  OrderReceiveSelectChoiceProductReqDto,
  OrderReceiveSendToMMsEmailReqDto,
} from './order.receive.req.dto';
import { OrderReceiveService } from '../application/order.receive.service';
import { ApiBadRequestResponse, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OrderReceiveAlimTalkResDto, OrderReceiveEmailResDto } from './order.receive.res.dto';

@ApiTags('/order/receive')
@Controller('')
export class OrderReceiveController {
  constructor(private readonly orderReceiveService: OrderReceiveService) {}

  @ApiOperation({
    summary: '초이스 쿠폰 선택 API',
  })
  @ApiOkResponse({
    description: '초이스 쿠폰 선택에 성공한 경우',
  })
  @ApiBadRequestResponse({
    description: '',
  })
  // ====================================================
  @Post('/order/receive/select/choice-product')
  selectChoiceProduct(@Body() getBody: OrderReceiveSelectChoiceProductReqDto) {
    return this.orderReceiveService.selectChoiceProduct(getBody);
  }

  @ApiOperation({
    summary: '쿠폰 알림톡 수신 API 혹은 초이스 쿠폰 수신 URL',
  })
  @ApiCreatedResponse({
    type: OrderReceiveAlimTalkResDto,
  })
  @ApiBadRequestResponse({
    description: '',
  })
  // ====================================================
  @Get('/order/receive/alim-talk')
  alimTalk(@Query() getQuery: OrderReceiveAlimTalkReqDto) {
    return this.orderReceiveService.alimTalk(getQuery);
  }

  @ApiOperation({
    summary: '쿠폰 이메일 수신 API',
  })
  @ApiCreatedResponse({
    type: OrderReceiveEmailResDto,
  })
  @ApiBadRequestResponse({
    description: '',
  })
  // ====================================================
  @Get('/order/receive/email')
  email(@Query() getQuery: OrderReceiveEmailReqDto) {
    return this.orderReceiveService.email(getQuery);
  }

  @ApiOperation({
    summary: '쿠폰 이메일 수신 MMS 전송 API',
  })
  @ApiCreatedResponse({
    description: '성공적으로 전송한 경우',
  })
  @ApiBadRequestResponse({
    description: '존재하지 않는 주문 정보 일 경우',
  })

  // ====================================================
  @Post('/order/receive/email/send-to-mms')
  sendToMMS(@Body() getBody: OrderReceiveSendToMMsEmailReqDto) {
    return this.orderReceiveService.sendToMMS(getBody);
  }
}
