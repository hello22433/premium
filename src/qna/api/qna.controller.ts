import { ApiBadRequestResponse, ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { QnaService } from '../application/qna.service';
import {
  QnaAnswerReqDto,
  QnaBulkDeleteReqDto,
  QnaCreateReqDto,
  QnaDeleteReqParamDto,
  QnaGetDetailReqParamDto,
  QnaGetListReqDto,
  QnaUpdateAnswerReqDto,
} from './qna.req.dto';
import { QnaBulkDeleteResDto, QnaGetDetailResDto, QnaGetListResDto, QnaGetMyQnaHistoryResDto } from './qna.res.dto';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { AuthUserSuperAdminGuard } from '../../auth/api/auth.user.super-admin.guard';
import { User } from '../../auth/api/user.decorator';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { AuthService } from '../../auth/application/auth.service';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';

@ApiTags('qna')
@ApiBearerAuth()
@Controller('')
@UseGuards(AuthUserAuthorizationGuard)
export class QnaController {
  constructor(
    private qnaService: QnaService,
    private authService: AuthService,
  ) {}

  @ApiOperation({
    summary: '1대1 문의 list API',
  })
  @ApiOkResponse({
    type: QnaGetListResDto,
    description: '리스트 조회에 성공한 경우',
  })
  // ===================================================
  @Get('/qna/list')
  async getList(@User() user: ILoginUserInfo, @Query() getQuery: QnaGetListReqDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.QNA);
    return this.qnaService.getList(user, getQuery);
  }

  @ApiOperation({
    summary: '1대1 문의 상세조회 API',
  })
  @ApiOkResponse({
    type: QnaGetDetailResDto,
    description: '상세 조회에 성공한 경우',
  })
  @ApiBadRequestResponse({
    description: '1대1 문의가 존재하지 않는 경우',
  })
  // ===================================================
  @Get('/qna/:id')
  getDetail(@User() user: ILoginUserInfo, @Param() getParam: QnaGetDetailReqParamDto) {
    return this.qnaService.getDetail(user, getParam);
  }

  @ApiOperation({
    summary: '1대1 문의 답변하기 API',
  })
  @ApiOkResponse({
    description: '답변 등록에 성공한 경우',
  })
  @ApiBadRequestResponse({
    description: '1대1 문의가 존재하지 않는 경우',
  })
  // ===================================================
  @Post('/qna/answer')
  answer(@User() user: ILoginUserInfo, @Body() getBody: QnaAnswerReqDto) {
    return this.qnaService.answer(user, getBody);
  }

  @ApiOperation({
    summary: '1대1 문의 답변 수정 API',
  })
  @ApiOkResponse({
    description: '답변 수정에 성공한 경우',
  })
  @ApiBadRequestResponse({
    description: '1대1 문의가 존재하지 않는 경우',
  })
  // ===================================================
  @Put('/qna/answer')
  update(@User() user: ILoginUserInfo, @Body() getBody: QnaUpdateAnswerReqDto) {
    return this.qnaService.update(user, getBody);
  }

  @ApiOperation({
    summary: '1대1 문의 등록 API',
  })
  @ApiOkResponse({
    description: '문의 등록에 성공한 경우',
  })
  // ===================================================
  @Post('/qna')
  create(@User() user: ILoginUserInfo, @Body() getBody: QnaCreateReqDto) {
    return this.qnaService.create(user, getBody);
  }

  @ApiOperation({
    summary: '대시보드 - 나의 문의 내역 조회 API',
  })
  @ApiOkResponse({
    type: QnaGetMyQnaHistoryResDto,
    description: '성공적으로 조회한 경우',
  })
  // ====================================================
  @Get('/qna/my/dashboard')
  getMyQnaHistory(@User() user: ILoginUserInfo) {
    return this.qnaService.getMyQnaHistory(user);
  }

  @ApiOperation({
    summary: '1대1 문의 일괄 삭제 API (최고관리자 전용)',
    description: 'soft delete 처리. 존재하지 않는 id는 무시되며, 실제 삭제된 건수만 응답에 반환됩니다.',
  })
  @ApiOkResponse({
    type: QnaBulkDeleteResDto,
    description: '삭제 처리 결과',
  })
  // ===================================================
  @UseGuards(AuthUserSuperAdminGuard)
  @Post('/qna/bulk-delete')
  bulkDelete(@Body() getBody: QnaBulkDeleteReqDto): Promise<QnaBulkDeleteResDto> {
    return this.qnaService.deleteMany(getBody);
  }

  @ApiOperation({
    summary: '1대1 문의 단건 삭제 API (최고관리자 전용)',
    description: 'soft delete 처리됩니다.',
  })
  @ApiOkResponse({
    description: '삭제에 성공한 경우',
  })
  @ApiBadRequestResponse({
    description: '1대1 문의가 존재하지 않는 경우',
  })
  // ===================================================
  @UseGuards(AuthUserSuperAdminGuard)
  @Delete('/qna/:id')
  deleteOne(@Param() getParam: QnaDeleteReqParamDto): Promise<void> {
    return this.qnaService.deleteOne(getParam);
  }
}
