import { ApiBadRequestResponse, ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Post, Put, Query, UseGuards } from '@nestjs/common';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { SsgEventService } from '../application/ssg.event.service';
import { SsgEventGetListResDto } from './ssg.event.res.dto';
import { SsgEventCreateReqDto, SsgEventGetListReqDto, SsgEventUpdateAmountReqDto } from './ssg.event.req.dto';

@ApiTags('ssg-event')
@ApiBearerAuth()
@Controller('')
@UseGuards(AuthUserAuthorizationGuard)
export class SsgEventController {
  constructor(private ssgEventService: SsgEventService) {}

  @ApiOperation({
    summary: '신세계 행사 리스트 조회 API',
    description: '신세계 행사 리스트를 조회합니다.',
  })
  @ApiOkResponse({
    type: SsgEventGetListResDto,
    description: '성공적으로 조회한 경우',
  })
  // =====================================
  @Get('/ssg-event/list')
  getList(@Query() getQuery: SsgEventGetListReqDto) {
    return this.ssgEventService.getList(getQuery);
  }

  @ApiOperation({
    summary: '신세계 행사 생성 API',
  })
  @ApiOkResponse({
    description: '성공적으로 생성한 경우',
  })
  // =====================================
  @Post('/ssg-event')
  create(@Body() getBody: SsgEventCreateReqDto) {
    return this.ssgEventService.create(getBody);
  }

  @ApiOperation({
    summary: '신세계 행사 금액 충전',
    description: '금액을 충전합니다.',
  })
  @ApiOkResponse({
    description: '성공적으로 충전한 경우',
  })
  @ApiBadRequestResponse({
    description: '존재하지 않는 행사인 경우',
  })
  // =====================================
  @Put('/ssg-event/amount')
  updateAmount(@Body() getBody: SsgEventUpdateAmountReqDto) {
    return this.ssgEventService.updateAmount(getBody);
  }
}
