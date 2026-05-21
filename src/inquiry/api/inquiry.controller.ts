import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { InquiryService } from '../application/inquiry.service';
import {
  InquiryCreateReqDto,
  InquiryGetDetailReqParamDto,
  InquiryGetListReqQueryDto,
  InquiryReplyReqDto,
} from './inquiry.req.dto';
import { InquiryGetDetailResDto, InquiryGetListResDto } from './inquiry.res.dto';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { AuthUserSuperAndOperationAdminGuard } from '../../auth/api/auth.user.super-operation-admin.guard';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { User } from '../../auth/api/user.decorator';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';
import { AuthService } from '../../auth/application/auth.service';

@ApiTags('inquiry')
@Controller('')
@UseGuards(AuthUserAuthorizationGuard)
export class InquiryController {
  constructor(
    private inquiryService: InquiryService,
    private authService: AuthService,
  ) {}

  @ApiOperation({
    summary: '1:1 문의 리스트 조회 API',
  })
  @ApiOkResponse({
    type: InquiryGetListResDto,
    description: '1:1 리스트 조회에 성공한 경우',
  })
  // ===================================================
  @Get('/inquiry/list')
  async getList(@User() user: ILoginUserInfo, @Query() getQuery: InquiryGetListReqQueryDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.QNA);
    return this.inquiryService.getList(getQuery);
  }

  @ApiOperation({
    summary: '1:1 문의 자세히 보기 API',
  })
  @ApiOkResponse({
    type: InquiryGetDetailResDto,
    description: '조회에 성공한 경우',
  })
  @ApiBadRequestResponse({
    description: '해당 1:1 문의가 존재하지 않는 경우',
  })
  // ===================================================
  @Get('/inquiry/detail/:id')
  async getDetail(@User() user: ILoginUserInfo, @Param() getParam: InquiryGetDetailReqParamDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.QNA);
    return this.inquiryService.getDetail(getParam);
  }

  @ApiOperation({
    summary: '1:1 문의 생성하기 ',
  })
  @ApiBearerAuth()
  @ApiCreatedResponse({
    description: '성공적으로 생성한 경우',
  })
  // ===================================================
  @UseGuards(AuthUserAuthorizationGuard)
  @Post('/inquiry')
  create(@User() user: ILoginUserInfo, @Body() getBody: InquiryCreateReqDto) {
    return this.inquiryService.create(user, getBody);
  }

  @ApiOperation({
    summary: '1:1 문의 답변하기',
  })
  @ApiBearerAuth()
  @ApiCreatedResponse({
    description: '성공적으로 생성한 경우',
  })
  @ApiBadRequestResponse({ description: '1:1문의가 존재하지 않는 경우' })
  // ===================================================
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
  @Post('/inquiry/reply')
  reply(@User() user: ILoginUserInfo, @Body() getBody: InquiryReplyReqDto) {
    return this.inquiryService.reply(user, getBody);
  }
}
