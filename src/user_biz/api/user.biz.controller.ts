import { Controller, Get, Param } from '@nestjs/common';
import { UserBizService } from '../application/user.biz.service';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserBizGetBuzInfoResDto } from './user.biz.res.dto';

@ApiTags('user-biz')
@Controller('')
export class UserBizController {
  constructor(private userBizService: UserBizService) {}

  @ApiOperation({
    summary: '사업자 등록 번호 조회하기 API',
    description: 'bizNo(사업자 등록 번호) 입력시 크롤링으로 데이터를 조회합니다.',
  })
  @ApiOkResponse({
    type: UserBizGetBuzInfoResDto,
    description: '',
  })
  // ==================================================================
  @Get('/user-biz/:bizNo')
  getBuzInfo(@Param('bizNo') bizNo: string): Promise<UserBizGetBuzInfoResDto> {
    return this.userBizService.getBuzInfo(bizNo);
  }
}
