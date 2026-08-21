import { Body, Controller, Delete, Get, Logger, Param, Patch, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import fs from 'node:fs';
import { pipeline } from 'node:stream';
import { OrderReceiptService } from '../application/order.receipt.service';
import {
  OrderReceiptCreateReqDto,
  OrderReceiptFileDownloadReqQueryDto,
  OrderReceiptGetDetailReqParamDto,
  OrderReceiptGetListReqQueryDto,
  OrderReceiptRejectReqDto,
  OrderReceiptUpdateReqDto,
  OrderReceiptChangeStatusReqDto,
  OrderReceiptPreviewReqDto,
} from './order.receipt.req.dto';
import { OrderReceiptGetDetailResDto, OrderReceiptGetListResDto } from './order.receipt.res.dto';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { User } from '../../auth/api/user.decorator';
import { AuthService } from '../../auth/application/auth.service';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';
import { buildContentDispositionAttachment } from '../../util/file.util';

@ApiTags('order-receipt')
@Controller('')
@UseGuards(AuthUserAuthorizationGuard)
export class OrderReceiptController {
  private readonly logger = new Logger('ORDER_RECEIPT');

  constructor(
    private orderReceiptService: OrderReceiptService,
    private authService: AuthService,
  ) {}

  @ApiOperation({
    summary: '주문접수 list API',
  })
  @ApiOkResponse({
    type: OrderReceiptGetListResDto,
    description: '리스트 조회에 성공한 경우',
  })
  // ===================================================
  @Get('/order-receipt/list')
  async getList(@User() user: ILoginUserInfo, @Query() getQuery: OrderReceiptGetListReqQueryDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.ORDER_RECEIPT);
    return this.orderReceiptService.getList(user, getQuery);
  }

  @ApiOperation({
    summary: '주문접수 detail API',
  })
  @ApiOkResponse({
    type: OrderReceiptGetDetailResDto,
    description: '상세 조회에 성공한 경우',
  })
  // ===================================================
  @Get('/order-receipt/:id')
  async getDetail(@User() user: ILoginUserInfo, @Param() getParam: OrderReceiptGetDetailReqParamDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.ORDER_RECEIPT);
    return this.orderReceiptService.getDetail(user, getParam);
  }

  @ApiOperation({
    summary: '주문접수 첨부 다운로드 API',
    description:
      '비공개(private) 저장된 주문접수 첨부를 권한검증 후 백엔드가 스트리밍합니다. ' +
      '다운로드 파일명은 원본명으로 내려갑니다. (운영/최고관리자=전체, 기업관리자=본인 문서만)',
  })
  @ApiOkResponse({ description: '다운로드 성공' })
  @ApiBadRequestResponse({ description: '주문접수/첨부가 존재하지 않는 경우' })
  // ===================================================
  @Get('/order-receipt/:id/file/download')
  async downloadFile(
    @User() user: ILoginUserInfo,
    @Param() getParam: OrderReceiptGetDetailReqParamDto,
    @Query() getQuery: OrderReceiptFileDownloadReqQueryDto,
    @Res() res: Response,
  ) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.ORDER_RECEIPT);

    const { fileName, filePath } = await this.orderReceiptService.downloadFile(user, getParam.id, getQuery.fileUrl);

    // 한글 등 비ASCII 는 RFC5987 filename* 로, 구형 클라이언트용 ASCII filename 도 함께 둔다.
    // ※ 인라인으로 조립하던 것을 공용 헬퍼로 옮겼다(문서함 컨트롤러와 같은 코드였다). 두 가지가 같이 닫힌다:
    //   ① ASCII 폴백이 역슬래시를 안 지워, 이름이 역슬래시로 끝나면 quoted-pair 로 읽혀 헤더가 깨졌다.
    //   ② encodeURIComponent 가 안 바꾸는 `'()*` 가 RFC5987 attr-char 에 없어, `계약서(최종).pdf` 같은
    //      이름에서 엄격한 클라이언트가 filename* 를 통째로 무시하고 밑줄 폴백으로 떨어졌다.
    // ★ 스트림이 '열린 것' 을 확인한 뒤에 헤더를 건다.
    //   fs.createReadStream 은 파일을 동기로 열지 않는다. 임시파일이 사라졌거나 권한·FD 부족으로
    //   open 이 비동기 실패하면, 이미 attachment 헤더를 건 뒤라 pipeline 이 res 를 destroy 해 버리고
    //   클라이언트는 500 JSON 이 아니라 ECONNRESET 을 받는다(원인을 알 길이 없다).
    //   open 을 기다린 뒤 헤더를 걸면 실패가 헤더 없는 예외로 나가 ExceptionFilter 가 500 으로 바꾼다.
    //   (문서함 컨트롤러가 리뷰 지적으로 먼저 고친 것 — 형제도 같은 구조라 같이 맞춘다.)
    const fileStream = fs.createReadStream(filePath);
    try {
      await new Promise<void>((resolve, reject) => {
        const onOpen = () => {
          fileStream.off('error', onError);
          resolve();
        };
        const onError = (openErr: Error) => {
          fileStream.off('open', onOpen);
          reject(openErr);
        };
        fileStream.once('open', onOpen);
        fileStream.once('error', onError);
      });
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
      res.setHeader('Content-Disposition', buildContentDispositionAttachment(fileName));
    } catch (setupErr) {
      fileStream.destroy();
      this.removeTempQuietly(filePath);
      throw setupErr;
    }

    // pipeline은 성공/스트림오류/클라이언트 조기 종료(res close) 등 '모든' 종료 경로에서 콜백을 1회 호출하고
    // 두 스트림을 정리한다 → 어느 경로로 끝나든 임시파일을 확실히 삭제한다.
    // (과거엔 read 스트림의 end/error에만 unlink를 걸어, 클라이언트가 중간에 끊으면 read 쪽엔 end·error가
    //  안 떠서 temp 파일이 tmpdir에 무기한 쌓였다.)
    pipeline(fileStream, res, (err) => {
      this.removeTempQuietly(filePath);
      if (!err) return;
      // 클라이언트 조기 종료는 정상적인 취소이므로 warn, 그 외 실제 오류만 error + (헤더 전이면) 500.
      if ((err as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE') {
        this.logger.warn(`주문접수 첨부 다운로드 중단(클라이언트 종료): ${filePath}`);
        return;
      }
      this.logger.error(`주문접수 첨부 스트림 오류: ${err}`);
      // pipeline이 오류 시 res를 이미 destroy하므로, 헤더 전·미파괴일 때만 안전하게 500 본문을 쓴다.
      if (!res.headersSent && !res.destroyed) {
        res.status(500).json({ message: '파일 다운로드 중 오류가 발생했습니다.' });
      }
    });
  }

  /**
   * 스트리밍용 임시파일 정리. 이미 없으면(ENOENT) 조용히, 그 외 실패만 누수로 남긴다.
   *
   * ★ unlink 실패(EBUSY/EPERM 등)를 삼키면 pipeline 도입이 막으려던 temp 누수가 조용히 다시 생긴다.
   *   성공 경로와 open 실패 경로가 같은 정리를 쓰도록 한 곳으로 묶는다(문서함 컨트롤러와 같은 형태).
   */
  private removeTempQuietly(filePath: string): void {
    fs.unlink(filePath, (unlinkErr) => {
      if (unlinkErr && (unlinkErr as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn(`주문접수 첨부 임시파일 삭제 실패(누수 가능): ${filePath} — ${unlinkErr.message}`);
      }
    });
  }

  @ApiOperation({
    summary: '주문접수 등록 API',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '주문접수 등록에 성공한 경우',
  })
  // ===================================================
  @Post('/order-receipt')
  async create(@User() user: ILoginUserInfo, @Body() getBody: OrderReceiptCreateReqDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.ORDER_RECEIPT);
    return this.orderReceiptService.create(user, getBody);
  }

  @ApiOperation({
    summary: '주문접수 자동주문 미리보기 API',
    description:
      '첨부 집행신청서를 파싱해 승인 시 생성/차단될 주문을 미리 계산합니다(DB 무변경). ' +
      '운영관리자 이상만 조회 가능.',
  })
  @ApiBearerAuth()
  @ApiOkResponse({ description: '미리보기 계산에 성공한 경우' })
  @ApiBadRequestResponse({ description: '주문접수 건이 존재하지 않는 경우' })
  // ===================================================
  @Post('/order-receipt/:id/preview')
  async previewAutoOrder(
    @User() user: ILoginUserInfo,
    @Param() getParam: OrderReceiptGetDetailReqParamDto,
    @Body() getBody: OrderReceiptPreviewReqDto,
  ) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.ORDER_RECEIPT);
    return this.orderReceiptService.previewAutoOrder(user, getParam.id, getBody.fileIndexes);
  }

  @ApiOperation({
    summary: '주문접수 자동주문 결과 조회 API',
    description: '승인 시 생성된 자동주문 리포트(저장 스냅샷)를 반환합니다. 운영관리자 이상만 조회 가능.',
  })
  @ApiBearerAuth()
  @ApiOkResponse({ description: '자동주문 결과 조회에 성공한 경우' })
  // ===================================================
  @Get('/order-receipt/:id/result')
  async getAutoOrderResult(@User() user: ILoginUserInfo, @Param() getParam: OrderReceiptGetDetailReqParamDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.ORDER_RECEIPT);
    return this.orderReceiptService.getAutoOrderResult(user, getParam.id);
  }

  @ApiOperation({
    summary: '주문접수 승인 API',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '주문접수 승인에 성공한 경우',
  })
  @ApiBadRequestResponse({
    description: '주문접수 건이 존재하지 않거나 접수 상태가 아닌 경우',
  })
  // ===================================================
  @Put('/order-receipt/:id/approve')
  async approve(@User() user: ILoginUserInfo, @Param() getParam: OrderReceiptGetDetailReqParamDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.ORDER_RECEIPT);
    return this.orderReceiptService.approve(user, getParam.id);
  }

  @ApiOperation({
    summary: '주문접수 반려 API',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '주문접수 반려에 성공한 경우',
  })
  @ApiBadRequestResponse({
    description: '주문접수 건이 존재하지 않거나 접수 상태가 아닌 경우',
  })
  // ===================================================
  @Put('/order-receipt/:id/reject')
  async reject(
    @User() user: ILoginUserInfo,
    @Param() getParam: OrderReceiptGetDetailReqParamDto,
    @Body() getBody: OrderReceiptRejectReqDto,
  ) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.ORDER_RECEIPT);
    return this.orderReceiptService.reject(user, getParam.id, getBody);
  }

  @ApiOperation({
    summary: '주문접수 상태 변경 API',
    description: '운영관리자 이상만 상태를 자유롭게 변경할 수 있습니다.',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '상태 변경에 성공한 경우',
  })
  @ApiBadRequestResponse({
    description: '주문접수 건이 존재하지 않는 경우',
  })
  // ===================================================
  @Patch('/order-receipt/:id/status')
  async changeStatus(
    @User() user: ILoginUserInfo,
    @Param() getParam: OrderReceiptGetDetailReqParamDto,
    @Body() getBody: OrderReceiptChangeStatusReqDto,
  ) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.ORDER_RECEIPT);
    return this.orderReceiptService.changeStatus(user, getParam.id, getBody);
  }

  @ApiOperation({
    summary: '주문접수 삭제 API',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '주문접수 삭제에 성공한 경우',
  })
  @ApiBadRequestResponse({
    description: '주문접수 건이 존재하지 않는 경우',
  })
  // ===================================================
  @Delete('/order-receipt/:id')
  async delete(@User() user: ILoginUserInfo, @Param() getParam: OrderReceiptGetDetailReqParamDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.ORDER_RECEIPT);
    return this.orderReceiptService.delete(user, getParam.id);
  }

  @ApiOperation({
    summary: '주문접수 수정 API (통합)',
    description:
      '기업관리자 본인(접수 상태): title, filePath, requestNote 수정 가능. ' +
      '운영관리자 이상: confirmNote 수정 가능(상태 무관). ' +
      '각 권한에 해당하는 필드만 전송하면 됩니다.',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '주문접수 수정에 성공한 경우',
  })
  @ApiBadRequestResponse({
    description: '주문접수 건이 존재하지 않거나 수정 권한이 없는 경우',
  })
  // ===================================================
  // Note: PUT /:id 는 /:id/approve, /:id/reject 등 뒤에 배치해야 라우트 충돌 방지
  @Put('/order-receipt/:id')
  async update(
    @User() user: ILoginUserInfo,
    @Param() getParam: OrderReceiptGetDetailReqParamDto,
    @Body() getBody: OrderReceiptUpdateReqDto,
  ) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.ORDER_RECEIPT);
    return this.orderReceiptService.update(user, getParam.id, getBody);
  }
}
