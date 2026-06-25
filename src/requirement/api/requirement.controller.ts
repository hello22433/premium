import { RequirementService } from '../application/requirement.service';
import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  RequirementCommentCreateReqDto,
  RequirementCommentDeleteReqParamDto,
  RequirementCommentUpdateReqDto,
  RequirementCommentUpdateReqParamDto,
  RequirementCreateReqDto,
  RequirementGetDetailReqParamDto,
  RequirementGetListReqQueryDto,
  RequirementUpdateReqDto,
  RequirementUpdateStatusReqDto,
} from './requirement.req.dto';
import { RequirementGetDetailResDto, RequirementGetListResDto } from './requirement.res.dto';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { User } from '../../auth/api/user.decorator';
import { AuthService } from '../../auth/application/auth.service';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';
import { Response } from 'express';

@ApiTags('requirement')
@Controller('')
@UseGuards(AuthUserAuthorizationGuard)
export class RequirementController {
  constructor(
    private requirementService: RequirementService,
    private authService: AuthService,
  ) {}

  @ApiOperation({
    summary: '개발 요구사항 list API',
  })
  @ApiOkResponse({
    type: RequirementGetListResDto,
    description: '리스트 조회에 성공한 경우',
  })
  // ===================================================
  @Get('/requirement/list')
  async getList(@User() user: ILoginUserInfo, @Query() getQuery: RequirementGetListReqQueryDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.REQUIREMENT);
    return this.requirementService.getList(getQuery);
  }

  @ApiOperation({
    summary: '개발 요구사항 상세 API',
  })
  @ApiOkResponse({
    type: RequirementGetDetailResDto,
    description: '상세 조회에 성공한 경우',
  })
  // ===================================================
  @Get('/requirement/:id')
  async getDetail(@User() user: ILoginUserInfo, @Param() getParam: RequirementGetDetailReqParamDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.REQUIREMENT);
    return this.requirementService.getDetail(getParam);
  }

  @ApiOperation({
    summary: '개발 요구사항 생성 API',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '요구사항 생성에 성공한 경우',
  })
  // ===================================================
  @Post('/requirement')
  async create(@User() user: ILoginUserInfo, @Body() getBody: RequirementCreateReqDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.REQUIREMENT);
    return this.requirementService.create(user, getBody);
  }

  @ApiOperation({
    summary: '개발 요구사항 수정 API',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '요구사항 수정에 성공한 경우',
  })
  @ApiBadRequestResponse({
    description: '요구사항이 존재하지 않는 경우',
  })
  // ===================================================
  @Put('/requirement')
  async update(@User() user: ILoginUserInfo, @Body() getBody: RequirementUpdateReqDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.REQUIREMENT);
    return this.requirementService.update(user, getBody);
  }

  @ApiOperation({
    summary: '개발 요구사항 삭제 API',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '요구사항 삭제에 성공한 경우',
  })
  @ApiBadRequestResponse({
    description: '요구사항이 존재하지 않는 경우',
  })
  // ===================================================
  @Delete('/requirement/:id')
  async delete(@User() user: ILoginUserInfo, @Param() getParam: RequirementGetDetailReqParamDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.REQUIREMENT);
    return this.requirementService.delete(user, getParam.id);
  }

  @ApiOperation({
    summary: '개발 요구사항 상태 변경 API',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '상태 변경에 성공한 경우',
  })
  // ===================================================
  @Patch('/requirement/:id/status')
  async updateStatus(
    @User() user: ILoginUserInfo,
    @Param() getParam: RequirementGetDetailReqParamDto,
    @Body() getBody: RequirementUpdateStatusReqDto,
  ) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.REQUIREMENT);
    return this.requirementService.updateStatus(user, getParam.id, getBody);
  }

  @ApiOperation({
    summary: '개발 요구사항 댓글 추가 API',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '댓글 추가에 성공한 경우',
  })
  // ===================================================
  @Post('/requirement/:id/comment')
  async addComment(
    @User() user: ILoginUserInfo,
    @Param() getParam: RequirementGetDetailReqParamDto,
    @Body() getBody: RequirementCommentCreateReqDto,
  ) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.REQUIREMENT);
    return this.requirementService.addComment(user, getParam.id, getBody);
  }

  @ApiOperation({
    summary: '개발 요구사항 댓글 삭제 API',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '댓글 삭제에 성공한 경우',
  })
  // ===================================================
  @Delete('/requirement/:id/comment/:commentId')
  async deleteComment(@User() user: ILoginUserInfo, @Param() getParam: RequirementCommentDeleteReqParamDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.REQUIREMENT);
    return this.requirementService.deleteComment(user, getParam.id, getParam.commentId);
  }

  @ApiOperation({
    summary: '개발 요구사항 댓글 수정 API',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '댓글 수정에 성공한 경우',
  })
  // ===================================================
  @Patch('/requirement/:id/comment/:commentId')
  async updateComment(
    @User() user: ILoginUserInfo,
    @Param() getParam: RequirementCommentUpdateReqParamDto,
    @Body() getBody: RequirementCommentUpdateReqDto,
  ) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.REQUIREMENT);
    return this.requirementService.updateComment(user, getParam.id, getParam.commentId, getBody);
  }

  @ApiOperation({
    summary: '개발 요구사항 마크다운 다운로드 API',
  })
  @ApiOkResponse({
    description: '마크다운 파일 다운로드에 성공한 경우',
  })
  // ===================================================
  @Get('/requirement/:id/markdown')
  async downloadMarkdown(
    @User() user: ILoginUserInfo,
    @Param() getParam: RequirementGetDetailReqParamDto,
    @Res() res: Response,
  ) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.REQUIREMENT);

    // 마크다운 다운로드는 development@enmad.com 계정만 허용
    if (user.email !== 'development@enmad.com') {
      throw new ForbiddenException('마크다운 다운로드 권한이 없습니다.');
    }

    return this.requirementService.downloadMarkdown(getParam.id, res);
  }
}
