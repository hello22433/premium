import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fs from 'node:fs';
import { parseFilePathList } from '../../util/file.util';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OrderReceiptEntity } from '../../entity/order.receipt.entity';
import { FileService } from '../../file/application/file.service';
import {
  OrderReceiptCreateReqDto,
  OrderReceiptGetDetailReqParamDto,
  OrderReceiptGetListReqQueryDto,
  OrderReceiptRejectReqDto,
  OrderReceiptUpdateReqDto,
  OrderReceiptChangeStatusReqDto,
} from '../api/order.receipt.req.dto';
import { OrderReceiptGetDetailResDto, OrderReceiptGetListResDto } from '../api/order.receipt.res.dto';
import { OrderReceiptViewDto } from '../api/dto/order.receipt.view.dto';
import { OrderReceiptStatus } from '../interface/order.receipt.status';
import { DateFormatStr } from '../../common/domain/date.format.str';
import { format, subDays } from 'date-fns';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { IUserAuthority } from '../../user/interface/user.authority';

@Injectable()
export class OrderReceiptService {
  constructor(
    @InjectRepository(OrderReceiptEntity)
    private orderReceiptRepository: Repository<OrderReceiptEntity>,
    private fileService: FileService,
  ) {}

  async getList(user: ILoginUserInfo, getQuery: OrderReceiptGetListReqQueryDto): Promise<OrderReceiptGetListResDto> {
    const { take, page, status } = getQuery;

    const queryBuilder = this.orderReceiptRepository
      .createQueryBuilder('orderReceipt')
      .innerJoinAndSelect('orderReceipt.user', 'user');

    // 고객사(CORPORATE_ADMIN)는 본인 건만 + 180일 이내
    if (user.authority === IUserAuthority.CORPORATE_ADMIN) {
      const dateLimit = subDays(new Date(), 180);
      queryBuilder
        .andWhere('orderReceipt.userId = :userId', { userId: user.id })
        .andWhere('orderReceipt.registerAt >= :dateLimit', { dateLimit });
    }

    // 상태 필터
    if (status) {
      queryBuilder.andWhere('orderReceipt.status = :status', { status });
    }

    const skip = (page - 1) * take;
    queryBuilder.skip(skip).take(take).orderBy('orderReceipt.id', 'DESC');
    const [receiptList, totalCount] = await queryBuilder.getManyAndCount();

    const totalPage = Math.ceil(totalCount / take);

    const resultList: OrderReceiptViewDto[] = receiptList.map((receipt) => {
      const isFile = !!receipt.filePath;
      const fileCount = parseFilePathList(receipt.filePath).length;
      return {
        id: receipt.id,
        userId: receipt.userId,
        userName: receipt.user.personName,
        title: receipt.title,
        status: receipt.status,
        isFile,
        fileCount,
        registerAt: format(receipt.registerAt, DateFormatStr),
        processedAt: receipt.processedAt ? format(receipt.processedAt, DateFormatStr) : null,
      };
    });

    return { list: resultList, totalCount, totalPage, currentPage: page };
  }

  async getDetail(
    user: ILoginUserInfo,
    getParam: OrderReceiptGetDetailReqParamDto,
  ): Promise<OrderReceiptGetDetailResDto> {
    const { id } = getParam;

    const receipt = await this.orderReceiptRepository.findOne({
      where: { id },
      relations: ['user', 'user.company', 'processedUser'],
    });

    if (!receipt) {
      throw new BadRequestException('주문접수 건이 존재하지 않습니다.');
    }

    this.assertCanReadReceipt(user, receipt);

    const fileUrlList = parseFilePathList(receipt.filePath);
    // 원본 파일명(메타데이터)까지 함께 — FE 가 화면 표시·다운로드명 모두 진짜 이름으로 일관되게.
    const files = await Promise.all(
      fileUrlList.map(async (url) => ({ url, name: await this.fileService.getOriginalName(url) })),
    );

    return {
      id: receipt.id,
      userId: receipt.userId,
      userName: receipt.user.personName,
      userCompanyName: receipt.user.company?.businessName ?? null,
      title: receipt.title,
      status: receipt.status,
      filePathList: fileUrlList,
      files,
      rejectReason: receipt.rejectReason,
      requestNote: receipt.requestNote,
      confirmNote: receipt.confirmNote,
      registerAt: format(receipt.registerAt, DateFormatStr),
      processedAt: receipt.processedAt ? format(receipt.processedAt, DateFormatStr) : null,
      processedUserName: receipt.processedUser?.personName ?? null,
    };
  }

  /**
   * 첨부 다운로드 프록시용. 권한·소유 검증 후 비공개(private) S3 객체를 임시파일로 받아
   * 로컬 경로와 원본 파일명을 돌려준다. 컨트롤러가 Content-Disposition(원본명)으로 스트리밍한다.
   *  - 문서 권한: 상세조회와 동일(assertCanReadReceipt) — 관리자 전체, 기업=본인+180일 이내.
   *  - 객체 소유 검증(assertDownloadable): key 의 ownerId 가 요청자(or 관리자)여야 함.
   *    → filePath 는 클라이언트가 임의 지정 가능하므로 includes() 만으론 불충분.
   *      private/{ownerId}/ 의 소유자까지 봐서 "남의 private 객체 우회 read" 를 차단한다.
   *  - 원본명: 객체 메타데이터(verbatim) 우선, 없으면 key 복원.
   */
  async downloadFile(
    user: ILoginUserInfo,
    id: number,
    fileUrl: string,
  ): Promise<{ fileName: string; filePath: string }> {
    const receipt = await this.findReceiptOrThrow(id);

    // 상세조회와 동일 규칙(기업관리자 180일 제한 포함) — 리스트에서 안 보이는 문서의 첨부도 못 받게.
    this.assertCanReadReceipt(user, receipt);

    // 1차: 이 주문접수에 첨부된 URL 인지
    const fileUrlList = parseFilePathList(receipt.filePath);
    if (!fileUrlList.includes(fileUrl)) {
      throw new BadRequestException('해당 주문접수의 첨부파일이 아닙니다.');
    }

    // 2차(핵심): 이 객체를 이 요청자가 받을 자격이 있나 — filePath 가 신뢰 불가하므로 key 소유까지 검증
    this.assertDownloadable(fileUrl, user);

    const fileName = await this.fileService.getOriginalName(fileUrl);

    const downloadDir = join(tmpdir(), 'epopkon-order-receipt');
    fs.mkdirSync(downloadDir, { recursive: true });

    // 로컬 임시 파일명은 충돌 방지를 위해 무작위(UUID). 사용자에게 보일 이름은 위 fileName.
    const filePath = await this.fileService.downloadWithPath(downloadDir, randomUUID(), fileUrl);

    return { fileName, filePath };
  }

  /**
   * 클라이언트가 filePath 에 임의 S3 key 를 심어 백엔드 자격증명으로 타인 객체를 우회 read 하는 것을 차단.
   *  - private/{ownerId}/... : ownerId 가 요청자(or 관리자)일 때만 허용. ownerId 세그먼트가 없는
   *    구(舊) private key(예: 공유리스트)는 주문접수 첨부가 아니므로 차단.
   *  - file/ · image/ (공개 객체) : 이미 공개라 추가 노출 아님(과거 첨부 호환). 허용.
   *  - 그 외 위치 : 차단.
   */
  private assertDownloadable(fileUrl: string, user: ILoginUserInfo) {
    const key = this.fileService.extractStorageKey(fileUrl);

    if (key.startsWith('private/')) {
      const ownerId = Number(key.split('/')[1]);
      if (!Number.isInteger(ownerId)) {
        throw new ForbiddenException('다운로드할 수 없는 파일입니다.');
      }
      if (!this.isAdminUser(user) && ownerId !== user.id) {
        throw new ForbiddenException('다운로드 권한이 없습니다.');
      }
      return;
    }

    if (key.startsWith('file/') || key.startsWith('image/')) {
      return;
    }

    throw new ForbiddenException('다운로드할 수 없는 파일입니다.');
  }

  async create(user: ILoginUserInfo, getBody: OrderReceiptCreateReqDto) {
    const { title, filePath, requestNote } = getBody;

    if (filePath.length === 0) {
      throw new BadRequestException('첨부파일을 등록해주세요.');
    }

    await this.orderReceiptRepository.insert({
      userId: user.id,
      title,
      status: OrderReceiptStatus.RECEIVED,
      filePath: filePath.join(','),
      requestNote: requestNote ?? null,
      registerAt: new Date(),
    });
  }

  async approve(user: ILoginUserInfo, id: number) {
    this.validateAdminAuthority(user, '운영관리자 이상만 승인할 수 있습니다.');

    const receipt = await this.findReceiptOrThrow(id);

    if (receipt.status !== OrderReceiptStatus.RECEIVED) {
      throw new BadRequestException('접수 상태인 건만 승인할 수 있습니다.');
    }

    this.applyNonRejectedStatus(receipt, OrderReceiptStatus.APPROVED, user);
    await this.orderReceiptRepository.save(receipt);
  }

  async reject(user: ILoginUserInfo, id: number, getBody: OrderReceiptRejectReqDto) {
    this.validateAdminAuthority(user, '운영관리자 이상만 반려할 수 있습니다.');

    const receipt = await this.findReceiptOrThrow(id);

    if (receipt.status !== OrderReceiptStatus.RECEIVED) {
      throw new BadRequestException('접수 상태인 건만 반려할 수 있습니다.');
    }

    receipt.status = OrderReceiptStatus.REJECTED;
    receipt.rejectReason = getBody.rejectReason.trim();
    receipt.processedAt = new Date();
    receipt.processedUserId = user.id;
    await this.orderReceiptRepository.save(receipt);
  }

  async delete(user: ILoginUserInfo, id: number) {
    const receipt = await this.findReceiptOrThrow(id);

    // 본인 건만 삭제 가능, SUPER_ADMIN은 모두 삭제 가능
    const isSuperAdmin = user.authority === IUserAuthority.SUPER_ADMIN;
    const isOwner = receipt.userId === user.id;

    if (!isSuperAdmin && !isOwner) {
      throw new ForbiddenException('삭제 권한이 없습니다.');
    }

    // 승인된 건은 삭제 불가
    if (receipt.status === OrderReceiptStatus.APPROVED) {
      throw new BadRequestException('승인된 건은 삭제할 수 없습니다.');
    }

    if (isOwner && !isSuperAdmin && receipt.status === OrderReceiptStatus.REVIEWING) {
      throw new BadRequestException('검토 중인 건은 삭제할 수 없습니다.');
    }

    await this.orderReceiptRepository.softDelete(id);
  }

  async update(user: ILoginUserInfo, id: number, getBody: OrderReceiptUpdateReqDto) {
    const receipt = await this.findReceiptOrThrow(id);

    const isAdmin = this.isAdminUser(user);
    const isOwner = receipt.userId === user.id;
    const isReceived = receipt.status === OrderReceiptStatus.RECEIVED;
    const canEditCorporateFields = isOwner && isReceived;

    // 수정 권한 검증 (fail fast)
    if (!canEditCorporateFields && !isAdmin) {
      throw new ForbiddenException('수정 권한이 없습니다.');
    }

    // 기업관리자 본인 + 접수 상태: title, filePath, requestNote 수정 가능
    if (canEditCorporateFields) {
      let modified = false;

      if (getBody.title !== undefined) {
        receipt.title = getBody.title;
        modified = true;
      }
      if (getBody.filePath !== undefined) {
        if (getBody.filePath.length === 0) {
          throw new BadRequestException('첨부파일을 등록해주세요.');
        }
        receipt.filePath = getBody.filePath.join(',');
        modified = true;
      }
      if (getBody.requestNote !== undefined) {
        receipt.requestNote = getBody.requestNote ?? null;
        modified = true;
      }

      if (modified) {
        receipt.registerAt = new Date();
      }
    }

    // 운영관리자 이상: confirmNote 수정 가능 (상태 무관)
    if (isAdmin && getBody.confirmNote !== undefined) {
      receipt.confirmNote = getBody.confirmNote;
    }

    // 운영관리자 이상: rejectReason 수정 가능 (반려 상태만)
    if (isAdmin && getBody.rejectReason !== undefined) {
      if (receipt.status !== OrderReceiptStatus.REJECTED) {
        throw new BadRequestException('반려 상태인 건만 반려사유를 수정할 수 있습니다.');
      }
      receipt.rejectReason = getBody.rejectReason;
    }

    await this.orderReceiptRepository.save(receipt);
  }

  async changeStatus(user: ILoginUserInfo, id: number, getBody: OrderReceiptChangeStatusReqDto) {
    this.validateAdminAuthority(user, '운영관리자 이상만 상태를 변경할 수 있습니다.');

    const receipt = await this.findReceiptOrThrow(id);

    this.applyNonRejectedStatus(receipt, getBody.status, user);

    await this.orderReceiptRepository.save(receipt);
  }

  private isAdminUser(user: ILoginUserInfo): boolean {
    return [IUserAuthority.SUPER_ADMIN, IUserAuthority.OPERATION_ADMIN].includes(user.authority as IUserAuthority);
  }

  private validateAdminAuthority(user: ILoginUserInfo, message: string) {
    if (!this.isAdminUser(user)) {
      throw new ForbiddenException(message);
    }
  }

  private assertCanReadReceipt(user: ILoginUserInfo, receipt: OrderReceiptEntity) {
    if (this.isAdminUser(user)) {
      return;
    }

    if (user.authority !== IUserAuthority.CORPORATE_ADMIN || receipt.userId !== user.id) {
      throw new ForbiddenException('조회 권한이 없습니다.');
    }

    const dateLimit = subDays(new Date(), 180);
    if (receipt.registerAt < dateLimit) {
      throw new ForbiddenException('조회 권한이 없습니다.');
    }
  }

  private applyNonRejectedStatus(receipt: OrderReceiptEntity, status: OrderReceiptStatus, user: ILoginUserInfo) {
    if (status === OrderReceiptStatus.REJECTED) {
      throw new BadRequestException('반려 처리는 반려 API를 사용해주세요.');
    }

    receipt.status = status;
    receipt.rejectReason = null;

    if (status === OrderReceiptStatus.RECEIVED) {
      receipt.processedAt = null;
      receipt.processedUserId = null;
      return;
    }

    receipt.processedAt = new Date();
    receipt.processedUserId = user.id;
  }

  private async findReceiptOrThrow(id: number): Promise<OrderReceiptEntity> {
    const receipt = await this.orderReceiptRepository.findOne({ where: { id } });

    if (!receipt) {
      throw new BadRequestException('주문접수 건이 존재하지 않습니다.');
    }

    return receipt;
  }
}
