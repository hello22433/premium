import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  PartnerCompanyGetDetailResDto,
  PartnerCompanyGetListResDto,
  PartnerCompanyGetSearchListResDto,
} from './partner.company.res.dto';
import { PartnerCompanyService } from '../application/partner.company.service';
import {
  PartnerCompanyCreateReqDto,
  PartnerCompanyGetDetailReqParamDto,
  PartnerCompanyGetListReqQueryDto,
  PartnerCompanyGetSearchListReqQueryDto,
  PartnerCompanyUpdateReqDto,
} from './partner.company.req.dto';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { AuthService } from '../../auth/application/auth.service';
import { User } from '../../auth/api/user.decorator';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';

@ApiTags('partner-company')
@ApiBearerAuth()
@UseGuards(AuthUserAuthorizationGuard)
@Controller('')
export class PartnerCompanyController {
  constructor(
    private partnerCompanyService: PartnerCompanyService,
    private authService: AuthService,
  ) {}

  @ApiOperation({
    summary: '협력사 Select 리스트 조회 API',
    description: 'select 에서 사용할 전체 협력사 조회 API 입니다.',
  })
  @ApiOkResponse({
    type: PartnerCompanyGetSearchListResDto,
    description: '성공적으로 조회한 경우',
  })
  // =====================================
  @Get('/partner-company/select/list')
  getSelectList() {
    return this.partnerCompanyService.getSelectList();
  }

  @ApiOperation({
    summary: '협력사 찾기 리스트 조회 API',
  })
  @ApiOkResponse({
    type: PartnerCompanyGetSearchListResDto,
    description: '성공적으로 조회한 경우',
  })
  // =====================================
  @Get('/partner-company/search/list')
  async getSearchList(@User() user: ILoginUserInfo, @Query() getQuery: PartnerCompanyGetSearchListReqQueryDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.PARTNER);

    return this.partnerCompanyService.getSearchList(getQuery);
  }

  @ApiOperation({
    summary: '협력사 관리 list 조회 API',
    description: '고객 관리 -> 협력사 관리 list API 입니다.',
  })
  @ApiOkResponse({
    type: PartnerCompanyGetListResDto,
    description: '성공적으로 조회한 경우',
  })
  // =====================================
  @Get('/partner-company/list')
  getList(@Query() getQuery: PartnerCompanyGetListReqQueryDto) {
    return this.partnerCompanyService.getList(getQuery);
  }

  @ApiOperation({
    summary: '협력사 관리 detail 조회 API',
    description: '고객 관리 -> 협력사 관리 detail API 입니다.',
  })
  @ApiOkResponse({
    type: PartnerCompanyGetDetailResDto,
    description: '성공적으로 조회한 경우',
  })
  // =====================================
  @Get('/partner-company/detail/:id')
  getDetail(@Param() getParam: PartnerCompanyGetDetailReqParamDto) {
    return this.partnerCompanyService.getDetail(getParam);
  }

  @ApiOperation({
    summary: '협력사 관리 신규 등록 API',
  })
  @ApiOkResponse({
    description: '성공적으로 등록한 경우',
  })
  // =====================================
  @Post('/partner-company')
  create(@Body() getBody: PartnerCompanyCreateReqDto) {
    return this.partnerCompanyService.create(getBody);
  }

  @ApiOperation({
    summary: '협력사 관리 수정 API',
  })
  @ApiOkResponse({
    description: '성공적으로 수정한 경우',
  })
  @ApiBadRequestResponse({
    description: '해당 협력사가 존재하지 않는 경우',
  })
  // =====================================
  @Put('/partner-company')
  update(@Body() getBody: PartnerCompanyUpdateReqDto) {
    return this.partnerCompanyService.update(getBody);
  }
}
