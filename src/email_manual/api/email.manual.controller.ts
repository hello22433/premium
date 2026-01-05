import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { EmailManualService } from '../application/email.manual.service';
import { EmailManualUpsertReqDto } from './email.manual.req.dto';
import { EmailManualGetResDto } from './email.manual.res.dto';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { User } from '../../auth/api/user.decorator';
import { ILoginUserInfo } from '../../auth/interface/login.user';

@ApiTags('email-manual')
@Controller('email-manual')
export class EmailManualController {
  constructor(private emailManualService: EmailManualService) {}

  @ApiOperation({
    summary: '이메일 사용방법 기본값 조회',
    description: '시스템에 설정된 이메일 사용방법 기본값을 조회합니다.',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    type: EmailManualGetResDto,
    description: '이메일 사용방법 기본값',
  })
  @UseGuards(AuthUserAuthorizationGuard)
  @Get()
  async get(): Promise<EmailManualGetResDto> {
    return this.emailManualService.get();
  }

  @ApiOperation({
    summary: '이메일 사용방법 기본값 저장/수정',
    description: '이메일 사용방법 기본값을 저장하거나 수정합니다.',
  })
  @ApiBearerAuth()
  @UseGuards(AuthUserAuthorizationGuard)
  @Put()
  async upsert(@User() user: ILoginUserInfo, @Body() dto: EmailManualUpsertReqDto): Promise<void> {
    return this.emailManualService.upsert(user, dto);
  }
}
