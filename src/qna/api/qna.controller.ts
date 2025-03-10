import { ApiBadRequestResponse, ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { QnaService } from '../application/qna.service';
import {
  QnaAnswerReqDto,
  QnaCreateReqDto,
  QnaGetDetailReqParamDto,
  QnaGetListReqDto,
  QnaUpdateAnswerReqDto,
} from './qna.req.dto';
import { QnaGetDetailResDto, QnaGetListResDto } from './qna.res.dto';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { User } from '../../auth/api/user.decorator';
import { ILoginUserInfo } from '../../auth/interface/login.user';

@ApiTags('qna')
@ApiBearerAuth()
@Controller('')
@UseGuards(AuthUserAuthorizationGuard)
export class QnaController {
  constructor(private qnaService: QnaService) {}

  @ApiOperation({
    summary: '1대1 문의 list API',
  })
  @ApiOkResponse({
    type: QnaGetListResDto,
    description: '리스트 조회에 성공한 경우',
  })
  // ===================================================
  @Get('/qna/list')
  getList(@User() user: ILoginUserInfo, @Query() getQuery: QnaGetListReqDto) {
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
}
