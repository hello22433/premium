import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OrderReceiptService } from '../application/order.receipt.service';
import {
  OrderReceiptCreateReqDto,
  OrderReceiptGetDetailReqParamDto,
  OrderReceiptGetListReqQueryDto,
  OrderReceiptRejectReqDto,
  OrderReceiptUpdateReqDto,
  OrderReceiptUpdateMemoReqDto,
} from './order.receipt.req.dto';
import { OrderReceiptGetDetailResDto, OrderReceiptGetListResDto } from './order.receipt.res.dto';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { User } from '../../auth/api/user.decorator';
import { AuthService } from '../../auth/application/auth.service';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';

@ApiTags('order-receipt')
@Controller('')
@UseGuards(AuthUserAuthorizationGuard)
export class OrderReceiptController {
  constructor(
    private orderReceiptService: OrderReceiptService,
    private authService: AuthService,
  ) {}

  @ApiOperation({
    summary: '주문접수 list API',
  })
  @ApiOkResponse({
    type: OrderReceiptGetListResDto,
    description: '리스트 조회에 성공한 경우',
  })
  // ===================================================
  @Get('/order-receipt/list')
  async getList(@User() user: ILoginUserInfo, @Query() getQuery: OrderReceiptGetListReqQueryDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.ORDER_RECEIPT);
    return this.orderReceiptService.getList(user, getQuery);
  }

  @ApiOperation({
    summary: '주문접수 detail API',
  })
  @ApiOkResponse({
    type: OrderReceiptGetDetailResDto,
    description: '상세 조회에 성공한 경우',
  })
  // ===================================================
  @Get('/order-receipt/:id')
  async getDetail(@User() user: ILoginUserInfo, @Param() getParam: OrderReceiptGetDetailReqParamDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.ORDER_RECEIPT);
    return this.orderReceiptService.getDetail(getParam);
  }

  @ApiOperation({
    summary: '주문접수 등록 API',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '주문접수 등록에 성공한 경우',
  })
  // ===================================================
  @Post('/order-receipt')
  async create(@User() user: ILoginUserInfo, @Body() getBody: OrderReceiptCreateReqDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.ORDER_RECEIPT);
    return this.orderReceiptService.create(user, getBody);
  }

  @ApiOperation({
    summary: '주문접수 승인 API',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '주문접수 승인에 성공한 경우',
  })
  @ApiBadRequestResponse({
    description: '주문접수 건이 존재하지 않거나 접수 상태가 아닌 경우',
  })
  // ===================================================
  @Put('/order-receipt/:id/approve')
  async approve(@User() user: ILoginUserInfo, @Param() getParam: OrderReceiptGetDetailReqParamDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.ORDER_RECEIPT);
    return this.orderReceiptService.approve(user, getParam.id);
  }

  @ApiOperation({
    summary: '주문접수 반려 API',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '주문접수 반려에 성공한 경우',
  })
  @ApiBadRequestResponse({
    description: '주문접수 건이 존재하지 않거나 접수 상태가 아닌 경우',
  })
  // ===================================================
  @Put('/order-receipt/:id/reject')
  async reject(
    @User() user: ILoginUserInfo,
    @Param() getParam: OrderReceiptGetDetailReqParamDto,
    @Body() getBody: OrderReceiptRejectReqDto,
  ) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.ORDER_RECEIPT);
    return this.orderReceiptService.reject(user, getParam.id, getBody);
  }

  @ApiOperation({
    summary: '주문접수 확인사항 메모 수정 API',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '확인사항 메모 수정에 성공한 경우',
  })
  @ApiBadRequestResponse({
    description: '주문접수 건이 존재하지 않는 경우',
  })
  // ===================================================
  @Put('/order-receipt/:id/memo')
  async updateMemo(
    @User() user: ILoginUserInfo,
    @Param() getParam: OrderReceiptGetDetailReqParamDto,
    @Body() getBody: OrderReceiptUpdateMemoReqDto,
  ) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.ORDER_RECEIPT);
    return this.orderReceiptService.updateMemo(user, getParam.id, getBody);
  }

  @ApiOperation({
    summary: '주문접수 삭제 API',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '주문접수 삭제에 성공한 경우',
  })
  @ApiBadRequestResponse({
    description: '주문접수 건이 존재하지 않는 경우',
  })
  // ===================================================
  @Delete('/order-receipt/:id')
  async delete(@User() user: ILoginUserInfo, @Param() getParam: OrderReceiptGetDetailReqParamDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.ORDER_RECEIPT);
    return this.orderReceiptService.delete(user, getParam.id);
  }

  @ApiOperation({
    summary: '주문접수 수정 API',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '주문접수 수정에 성공한 경우',
  })
  @ApiBadRequestResponse({
    description: '주문접수 건이 존재하지 않거나 접수 상태가 아닌 경우',
  })
  // ===================================================
  // Note: PUT /:id 는 /:id/approve, /:id/reject, /:id/memo 뒤에 배치해야 라우트 충돌 방지
  @Put('/order-receipt/:id')
  async update(
    @User() user: ILoginUserInfo,
    @Param() getParam: OrderReceiptGetDetailReqParamDto,
    @Body() getBody: OrderReceiptUpdateReqDto,
  ) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.ORDER_RECEIPT);
    return this.orderReceiptService.update(user, getParam.id, getBody);
  }
}
