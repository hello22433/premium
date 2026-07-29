import { ApiBadRequestResponse, ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Delete, Get, Logger, Param, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import fs from 'node:fs';
import { pipeline } from 'node:stream';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { User } from '../../auth/api/user.decorator';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { UserDriveService } from '../application/user.drive.service';
import {
  UserDriveCreateReqDto,
  UserDriveFileDownloadReqQueryDto,
  UserDriveGetDetailReqParamDto,
  UserDriveGetListReqDto,
  UserDriveReplyReqDto,
  UserDriveUpdateReqDto,
} from './user.drive.req.dto';
import { UserDriveGetDetailResDto, UserDriveGetListResDto } from './user.drive.res.dto';
import { AuthUserSuperAndOperationAdminGuard } from '../../auth/api/auth.user.super-operation-admin.guard';

@ApiTags('user-drive')
@ApiBearerAuth()
@Controller('')
@UseGuards(AuthUserAuthorizationGuard)
export class UserDriveController {
  private readonly logger = new Logger('USER_DRIVE');

  constructor(private userDriveService: UserDriveService) {}

  @ApiOperation({
    summary: '문서함 list API',
    description: '기업관리자인 경우 자신에게 온 문서만 조회, 운영/최고관리자는 모두 조회 됩니다.',
  })
  @ApiOkResponse({
    type: UserDriveGetListResDto,
    description: '리스트 조회에 성공한 경우',
  })
  // ===================================================
  @Get('/user-drive/list')
  getList(@User() user: ILoginUserInfo, @Query() getQuery: UserDriveGetListReqDto) {
    return this.userDriveService.getList(user, getQuery);
  }

  @ApiOperation({
    summary: '문서함 문서 상세 조회 API',
    description: '기업관리자인 경우 자신에게 온 문서만 상세조회 가능하며, 운영/최고관리자는 모두 상세조회 됩니다.',
  })
  @ApiOkResponse({
    type: UserDriveGetDetailResDto,
    description: '리스트 조회에 성공한 경우',
  })
  // ===================================================
  @Get('/user-drive/:id')
  getDetail(@User() user: ILoginUserInfo, @Param() getParam: UserDriveGetDetailReqParamDto) {
    return this.userDriveService.getDetail(user, getParam);
  }

  @ApiOperation({
    summary: '문서함 첨부 다운로드 API',
    description:
      '비공개(private) 저장된 문서 첨부를 권한검증 후 백엔드가 스트리밍합니다. ' +
      '다운로드 파일명은 원본명으로 내려갑니다. (운영/최고관리자=전체, 기업관리자=본인 수신 문서만)',
  })
  @ApiOkResponse({ description: '다운로드 성공' })
  @ApiBadRequestResponse({ description: '문서/첨부가 존재하지 않는 경우' })
  // ===================================================
  @Get('/user-drive/:id/file/download')
  async downloadFile(
    @User() user: ILoginUserInfo,
    @Param() getParam: UserDriveGetDetailReqParamDto,
    @Query() getQuery: UserDriveFileDownloadReqQueryDto,
    @Res() res: Response,
  ) {
    const { fileName, filePath } = await this.userDriveService.downloadFile(user, getParam.id, getQuery.fileUrl);

    // 한글 등 비ASCII 는 RFC5987 filename* 로, 구형 클라이언트용 ASCII filename 도 함께 둔다.
    const asciiFallback = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
    const encodedFileName = encodeURIComponent(fileName);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodedFileName}`,
    );

    const fileStream = fs.createReadStream(filePath);
    // pipeline은 성공/스트림오류/클라이언트 조기 종료(res close) 등 '모든' 종료 경로에서 콜백을 1회 호출하고
    // 두 스트림을 정리한다 → 어느 경로로 끝나든 임시파일을 확실히 삭제한다.
    pipeline(fileStream, res, (err) => {
      fs.unlink(filePath, (unlinkErr) => {
        if (unlinkErr && (unlinkErr as NodeJS.ErrnoException).code !== 'ENOENT') {
          this.logger.warn(`문서함 첨부 임시파일 삭제 실패(누수 가능): ${filePath} — ${unlinkErr.message}`);
        }
      });
      if (!err) return;
      if ((err as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE') {
        this.logger.warn(`문서함 첨부 다운로드 중단(클라이언트 종료): ${filePath}`);
        return;
      }
      this.logger.error(`문서함 첨부 스트림 오류: ${err}`);
      if (!res.headersSent && !res.destroyed) {
        res.status(500).json({ message: '파일 다운로드 중 오류가 발생했습니다.' });
      }
    });
  }

  @ApiOperation({
    summary: '문서 생성 API',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '문서 생성에 성공한 경우',
  })
  // ===================================================
  @UseGuards(AuthUserAuthorizationGuard)
  @Post('/user-drive')
  create(@User() user: ILoginUserInfo, @Body() getBody: UserDriveCreateReqDto) {
    return this.userDriveService.create(user, getBody);
  }

  @ApiOperation({
    summary: '문서 수정 API',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '문서 수정에 성공한 경우',
  })
  @ApiBadRequestResponse({
    description: '문서가 존재하지 않는 경우',
  })
  // ===================================================
  @UseGuards(AuthUserAuthorizationGuard)
  @Put('/user-drive')
  update(@User() user: ILoginUserInfo, @Body() getBody: UserDriveUpdateReqDto) {
    return this.userDriveService.update(user, getBody);
  }

  @ApiOperation({
    summary: '문서 답변 API',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '문서 답변에 성공한 경우',
  })
  @ApiBadRequestResponse({
    description: '문서가 존재하지 않는 경우',
  })
  // ===================================================
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
  @Put('/user-drive/reply')
  reply(@User() user: ILoginUserInfo, @Body() getBody: UserDriveReplyReqDto) {
    return this.userDriveService.reply(user, getBody);
  }

  @ApiOperation({
    summary: '문서 삭제 API',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '문서 삭제에 성공한 경우',
  })
  @ApiBadRequestResponse({
    description: '문서가 존재하지 않는 경우',
  })
  // ===================================================
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
  @Delete('/user-drive/:id')
  delete(@User() user: ILoginUserInfo, @Param() getParam: UserDriveGetDetailReqParamDto) {
    return this.userDriveService.delete(user, getParam.id);
  }
}
