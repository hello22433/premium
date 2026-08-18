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
  UserDriveFileDownloadReqParamDto,
  UserDriveFileDownloadReqQueryDto,
  UserDriveGetDetailReqParamDto,
  UserDriveGetListReqDto,
  UserDriveReplyReqDto,
  UserDriveUpdateReqDto,
} from './user.drive.req.dto';
import { UserDriveGetDetailResDto, UserDriveGetListResDto } from './user.drive.res.dto';
import { AuthUserSuperAndOperationAdminGuard } from '../../auth/api/auth.user.super-operation-admin.guard';
import { buildContentDispositionAttachment } from '../../util/file.util';

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
    @Param() getParam: UserDriveFileDownloadReqParamDto,
    @Query() getQuery: UserDriveFileDownloadReqQueryDto,
    @Res() res: Response,
  ) {
    const { fileName, filePath } = await this.userDriveService.downloadFile(user, getParam.id, getQuery.fileUrl);

    // 스트림을 먼저 열고(동기 실패 시 헤더 오염 없이 임시파일 정리), 성공 후 헤더를 건다.
    // pipeline 배선 전에 실패하면 정리 콜백이 안 걸려 고아가 되므로 이 구간을 감싼다.
    let fileStream: fs.ReadStream;
    try {
      fileStream = fs.createReadStream(filePath);
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
      res.setHeader('Content-Disposition', buildContentDispositionAttachment(fileName));
    } catch (setupErr) {
      this.removeTempQuietly(filePath);
      throw setupErr;
    }
    // pipeline은 성공/스트림오류/클라이언트 조기 종료(res close) 등 '모든' 종료 경로에서 콜백을 1회 호출하고
    // 두 스트림을 정리한다 → 어느 경로로 끝나든 임시파일을 확실히 삭제한다.
    pipeline(fileStream, res, (err) => {
      this.removeTempQuietly(filePath);
      if (!err) return;
      if ((err as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE') {
        this.logger.warn(`문서함 첨부 다운로드 중단(클라이언트 종료): ${filePath}`);
        return;
      }
      this.logger.error(`문서함 첨부 스트림 오류: ${err}`, err instanceof Error ? err.stack : undefined);
      // ※ 이 분기는 거의 도달하지 않는다 — pipeline 은 오류 시 두 스트림을 destroy 하므로 여기 올 때는
      //   res.destroyed 가 이미 true 다(실측: headersSent=false / destroyed=true / 클라이언트는 ECONNRESET).
      //   즉 사용자가 보는 것은 이 JSON 이 아니라 브라우저의 "다운로드 실패" 이고, 원인을 아는 유일한
      //   창구는 바로 위 error 로그다. 남겨 두는 이유는 헤더 전 동기 실패 같은 예외 경로 대비이고,
      //   "500 JSON 이 나가니까 괜찮다" 로 읽으면 안 된다. 실제로 JSON 을 주려면 pipeline 앞에서
      //   소스 오류를 먼저 받아야 하는데, 그건 형제(order_receipt)와 같이 고쳐야 해 후속으로 뒀다.
      if (!res.headersSent && !res.destroyed) {
        // 데이터 전송 전 실패: attachment 헤더가 남아 에러 JSON 이 파일로 저장되지 않도록 제거 후 응답.
        res.removeHeader('Content-Disposition');
        res.removeHeader('Access-Control-Expose-Headers');
        res.status(500).json({ message: '파일 다운로드 중 오류가 발생했습니다.' });
      }
    });
  }

  /**
   * 스트리밍용 임시파일 정리. 이미 없으면(ENOENT) 조용히, 그 외 실패만 누수로 남긴다.
   *
   * ★ 한 곳으로 묶은 이유 — 예전엔 setup 실패 경로만 `fs.unlink(filePath, () => undefined)` 로 완전히
   *   침묵했다. 12줄 아래 pipeline 콜백과 형제(FileStorageS3.removeLocalFileQuietly)는 둘 다 남기는데
   *   한 곳만 안 남기는 비대칭이었고, 그 침묵이 막으려던 임시파일 누수를 조용히 되살린다.
   */
  private removeTempQuietly(filePath: string): void {
    fs.unlink(filePath, (unlinkErr) => {
      if (unlinkErr && (unlinkErr as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn(`문서함 첨부 임시파일 삭제 실패(누수 가능): ${filePath} — ${unlinkErr.message}`);
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
