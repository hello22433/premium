import { ApiBadRequestResponse, ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Delete, Get, Post, Query, UseGuards } from '@nestjs/common';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { UserDiscountService } from '../application/user.discount.service';
import { UserDiscountGetListResDto } from './user.discount.res.dto';
import { UserDiscountCreateReqDto, UserDiscountDeleteReqDto, UserDiscountGetListReqDto } from './user.discount.req.dto';
import { User } from '../../auth/api/user.decorator';
import { ILoginUserInfo } from '../../auth/interface/login.user';

@ApiTags('user-management')
@Controller('')
export class UserDiscountController {
  constructor(private userDiscountService: UserDiscountService) {}

  @ApiBearerAuth()
  @ApiOperation({
    summary: '할인 적용 내역 조회 API',
    description:
      '계정 관리 - 상세 조회시에 user id 를 전달하고, <br> 협력사 관리 - 상세 조회시에 partnerCompany id 를 전달하시면 됩니다.',
  })
  @ApiOkResponse({
    type: UserDiscountGetListResDto,
    description: '성공적으로 불러온 경우',
  })
  @ApiBadRequestResponse({
    description: '해당 계정의 적용된 할인 정보가 존재하지 않는 경우',
  })
  // ====================================
  @UseGuards(AuthUserAuthorizationGuard)
  @Get('/user-management/discount/list')
  getList(@Query() getQuery: UserDiscountGetListReqDto) {
    return this.userDiscountService.getList(getQuery);
  }

  @ApiBearerAuth()
  @ApiOperation({
    summary: '할인 옵션 적용 API',
    description:
      '계정 관리 - 상세 조회시에 user id 를 전달하고, <br> 협력사 관리 - 상세 조회시에 partnerCompany id 를 전달하시면 됩니다.',
  })
  @ApiOkResponse({
    description: '성공적으로 저장된 경우',
  })
  @ApiBadRequestResponse({
    description: '해당 계정이 존재하지 않는 경우',
  })
  // ====================================
  @UseGuards(AuthUserAuthorizationGuard)
  @Post('/user-management/discount')
  create(@User() user: ILoginUserInfo, @Body() getBody: UserDiscountCreateReqDto) {
    return this.userDiscountService.create(user, getBody);
  }

  @ApiBearerAuth()
  @ApiOperation({
    summary: '할인 옵션 삭제 API',
  })
  @ApiOkResponse({
    description: '성공적으로 삭제한 경우',
  })
  @ApiBadRequestResponse({
    description: '할인 옵션이 존재하지 않는 경우',
  })
  // ====================================
  @UseGuards(AuthUserAuthorizationGuard)
  @Delete('/user-management/discount')
  delete(@User() user: ILoginUserInfo, @Body() getBody: UserDiscountDeleteReqDto) {
    return this.userDiscountService.delete(user, getBody);
  }
}
