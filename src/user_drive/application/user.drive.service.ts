import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fs from 'node:fs';
import { parseFilePathList } from '../../util/file.util';
import { InjectRepository } from '@nestjs/typeorm';
import { UserDriveEntity } from '../../entity/user.drive.entity';
import { Repository } from 'typeorm';
import { FileService } from '../../file/application/file.service';
import {
  UserDriveCreateReqDto,
  UserDriveGetDetailReqParamDto,
  UserDriveGetListReqDto,
  UserDriveReplyReqDto,
  UserDriveUpdateReqDto,
} from '../api/user.drive.req.dto';
import { UserDriveViewDto } from '../api/dto/user.drive.view.dto';
import { UserDriveGetDetailResDto, UserDriveGetListResDto } from '../api/user.drive.res.dto';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { format } from 'date-fns';
import { DateFormatStr } from '../../common/domain/date.format.str';
import { UserEntity } from '../../entity/user.entity';
import { IUserDriveStatus } from '../interface/user.drive.status';
import { IUserAuthority } from '../../user/interface/user.authority';

@Injectable()
export class UserDriveService {
  /** 상세조회에서 원본명(HeadObject)을 조회하는 첨부 수 상한 — 초과분은 key 복원 폴백(S3 호출 폭주 방지) */
  static readonly MAX_FILE_META_LOOKUP = 10;

  constructor(
    @InjectRepository(UserDriveEntity)
    private userDriveRepository: Repository<UserDriveEntity>,
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
    private fileService: FileService,
  ) {}

  async getList(user: ILoginUserInfo, getQuery: UserDriveGetListReqDto): Promise<UserDriveGetListResDto> {
    const { take, page } = getQuery;

    let queryBuilder = this.userDriveRepository
      .createQueryBuilder('drive')
      .innerJoinAndSelect('drive.sender', 'sender')
      .innerJoinAndSelect('drive.receiver', 'receiver');

    if (user.authority === 'CORPORATE_ADMIN') {
      // 고객사에게는 DRAFT 상태 문서 미노출
      queryBuilder
        .where('drive.receiverId = :receiverId', { receiverId: user.id })
        .andWhere('drive.status != :draftStatus', { draftStatus: IUserDriveStatus.DRAFT });
    }

    queryBuilder.orderBy('drive.id', 'DESC');

    const skip = (page - 1) * take;
    queryBuilder = queryBuilder.skip(skip).take(take);
    const [driveList, totalCount] = await queryBuilder.getManyAndCount();

    const totalPage = Math.ceil(totalCount / take);

    const resultList: UserDriveViewDto[] = driveList.map((drive) => {
      const isFile = !!drive.filePath;
      return {
        id: drive.id,
        receiveAt: drive.receiveAt ? format(drive.receiveAt, DateFormatStr) : null,
        senderBusinessName: drive.sender.company?.businessName ?? '',
        receiverPersonName: drive.receiver.personName,
        senderName: drive.sender.personName,
        title: drive.title,
        status: drive.status,
        isFile: isFile,
      };
    });

    return { list: resultList, totalCount, totalPage, currentPage: page };
  }

  async getDetail(user: ILoginUserInfo, getParam: UserDriveGetDetailReqParamDto): Promise<UserDriveGetDetailResDto> {
    const { id } = getParam;
    const isCorporateAdmin = user.authority === 'CORPORATE_ADMIN';

    const whereCondition = isCorporateAdmin ? { id, receiverId: user.id } : { id };

    const userDrive = await this.userDriveRepository.findOne({
      where: whereCondition,
      relations: ['sender', 'receiver'],
    });

    if (!userDrive) {
      throw new BadRequestException('문서가 존재하지 않습니다.');
    }

    // 고객사에게는 DRAFT 상태 문서 미노출
    if (isCorporateAdmin && userDrive.status === IUserDriveStatus.DRAFT) {
      throw new BadRequestException('문서가 존재하지 않습니다.');
    }

    // 고객사가 조회 시 수신 시각 업데이트
    if (isCorporateAdmin) {
      userDrive.receiveAt = new Date();
      await this.userDriveRepository.save(userDrive);
    }

    const fileUrlList = parseFilePathList(userDrive.filePath);
    // 원본 파일명(메타데이터)까지 함께 — FE 가 화면 표시·다운로드명 모두 진짜 이름으로 일관되게.
    // S3 HeadObject 는 상한(MAX_FILE_META_LOOKUP)까지만 — 초과분은 key 복원 폴백(호출 폭주 방지).
    const files = await Promise.all(
      fileUrlList.map(async (url, index) =>
        index < UserDriveService.MAX_FILE_META_LOOKUP
          ? { url, name: await this.fileService.getOriginalName(url) }
          : { url, name: this.fileService.extractOriginalFileName(url) },
      ),
    );

    return {
      id: userDrive.id,
      sendAt: format(userDrive.sendAt, DateFormatStr),
      senderId: userDrive.senderId,
      receiverId: userDrive.receiverId,
      senderBusinessName: userDrive.sender.company?.businessName ?? '',
      receiverPersonName: userDrive.receiver.personName,
      receiverEmail: userDrive.receiver.email,
      receiverPhone: userDrive.receiver.personPhoneNumber,
      title: userDrive.title,
      content: userDrive.content,
      status: userDrive.status,
      filePathList: fileUrlList,
      files,
      replyContent: userDrive.replyContent,
    };
  }

  /**
   * 첨부 다운로드 프록시용. 권한·소유 검증 후 비공개(private) S3 객체를 임시파일로 받아
   * 로컬 경로와 원본 파일명을 돌려준다. 컨트롤러가 Content-Disposition(원본명)으로 스트리밍한다.
   *  - 문서 권한: 상세조회와 동일(assertCanReadDrive) — 관리자 전체, 기업=본인 수신 문서(비DRAFT)만.
   *  - 객체 소유 검증(assertDownloadable): 문서함 첨부는 관리자만 등록하므로 key 의 ownerId(업로더)는
   *    항상 관리자다. filePath 는 신뢰 불가하므로, 관리자 아닌 요청자(기업 수신자)에게는 "업로더가 관리자인
   *    첨부"만 허용해 심어진 타인 객체를 차단한다. ※ 주문접수와 달리 정당한 다운로더가 수신자(≠업로더)라
   *    요청자 id 로 비교하지 않는다.
   *  - 원본명: 객체 메타데이터(verbatim) 우선, 없으면 key 복원.
   */
  async downloadFile(
    user: ILoginUserInfo,
    id: number,
    fileUrl: string,
  ): Promise<{ fileName: string; filePath: string }> {
    const userDrive = await this.userDriveRepository.findOne({ where: { id } });
    if (!userDrive) {
      throw new BadRequestException('문서가 존재하지 않습니다.');
    }

    this.assertCanReadDrive(user, userDrive);

    const fileUrlList = parseFilePathList(userDrive.filePath);
    if (!fileUrlList.includes(fileUrl)) {
      throw new BadRequestException('해당 문서의 첨부파일이 아닙니다.');
    }

    await this.assertDownloadable(fileUrl, user);

    const fileName = await this.fileService.getOriginalName(fileUrl);

    const downloadDir = join(tmpdir(), 'epopkon-user-drive');
    fs.mkdirSync(downloadDir, { recursive: true });

    const filePath = await this.fileService.downloadWithPath(downloadDir, randomUUID(), fileUrl);

    return { fileName, filePath };
  }

  private isAdminAuthority(authority: IUserAuthority | string): boolean {
    return [IUserAuthority.SUPER_ADMIN, IUserAuthority.OPERATION_ADMIN].includes(authority as IUserAuthority);
  }

  private isAdminUser(user: ILoginUserInfo): boolean {
    return this.isAdminAuthority(user.authority);
  }

  /** 문서 읽기 권한 — 관리자 전체 / 기업관리자는 본인이 수신자이고 DRAFT 아님(상세조회와 동일 규칙). */
  private assertCanReadDrive(user: ILoginUserInfo, drive: UserDriveEntity) {
    if (this.isAdminUser(user)) {
      return;
    }

    if (
      user.authority !== IUserAuthority.CORPORATE_ADMIN ||
      drive.receiverId !== user.id ||
      drive.status === IUserDriveStatus.DRAFT
    ) {
      throw new ForbiddenException('조회 권한이 없습니다.');
    }
  }

  /**
   * 클라이언트가 filePath 에 임의 URL/key 를 심어 백엔드 자격증명으로 타인 객체를 우회 read 하는 것을 차단.
   *  - host: 우리 S3 버킷 URL 이 아니면 차단.
   *  - private/{ownerId}/... : 문서함 첨부는 관리자만 등록하므로, 정당한 첨부의 업로더(ownerId)는 항상 관리자다.
   *    따라서 관리자가 아닌 요청자(기업 수신자)는 "업로더가 관리자인 첨부"만 허용한다 → 심어진 타인(비관리자) 객체 차단.
   *    발신자 본인(senderId)뿐 아니라, 다른 관리자(예: SUPER 가 교차수정으로 추가)가 올린 첨부도 정상 다운로드된다.
   *    ownerId 세그먼트가 없는 구 private key 는 문서함 첨부가 아니므로 차단(NaN → Forbidden).
   *  - file/ : 전환 전 첨부(공개 객체) 호환용으로만 허용. 그 외 위치는 차단.
   */
  private async assertDownloadable(fileUrl: string, user: ILoginUserInfo): Promise<void> {
    if (!this.fileService.isOwnStorageUrl(fileUrl)) {
      throw new ForbiddenException('다운로드할 수 없는 파일입니다.');
    }

    const key = this.fileService.extractStorageKey(fileUrl);

    if (key.startsWith('private/')) {
      const ownerId = Number(key.split('/')[1]);
      if (!Number.isInteger(ownerId)) {
        throw new ForbiddenException('다운로드할 수 없는 파일입니다.');
      }
      // 관리자 요청자는 전체 허용. 그 외(기업 수신자)는 업로더가 관리자인 경우에만 허용한다.
      if (!this.isAdminUser(user)) {
        const uploader = await this.userRepository.findOne({ where: { id: ownerId } });
        if (!uploader || !this.isAdminAuthority(uploader.authority)) {
          throw new ForbiddenException('다운로드 권한이 없습니다.');
        }
      }
      return;
    }

    if (key.startsWith('file/')) {
      return;
    }

    throw new ForbiddenException('다운로드할 수 없는 파일입니다.');
  }

  async create(user: ILoginUserInfo, getBody: UserDriveCreateReqDto) {
    const { title, content, receiverId, filePath, status } = getBody;

    if (user.authority === 'CORPORATE_ADMIN') {
      throw new BadRequestException('관리자만 접근 가능합니다.');
    }

    const receiver = await this.userRepository.findOne({
      where: {
        id: receiverId,
      },
    });

    if (!receiver) {
      throw new BadRequestException('고객사가 존재 하지 않습니다.');
    }

    await this.userDriveRepository.insert({
      senderId: user.id,
      receiverId: receiver.id,
      title,
      content,
      sendAt: new Date(),
      status: status ?? IUserDriveStatus.REGISTER,
      filePath: filePath.length === 0 ? null : filePath.join(','),
    });

    return;
  }

  async update(user: ILoginUserInfo, getBody: UserDriveUpdateReqDto) {
    const { id, receiverId, title, content, filePath, status } = getBody;

    if (user.authority === 'CORPORATE_ADMIN') {
      throw new BadRequestException('관리자만 접근 가능합니다.');
    }

    const userDrive = await this.userDriveRepository.findOne({
      where: {
        id,
      },
    });

    if (!userDrive) {
      throw new BadRequestException('문서가 존재하지 않습니다.');
    }

    if (user.authority === IUserAuthority.OPERATION_ADMIN && userDrive.senderId !== user.id) {
      throw new ForbiddenException();
    }

    const receiver = await this.userRepository.findOne({
      where: {
        id: receiverId,
      },
    });

    if (!receiver) {
      throw new BadRequestException('고객사가 존재 하지 않습니다.');
    }

    userDrive.title = title;
    userDrive.content = content;
    userDrive.receiverId = receiverId;
    userDrive.status = status;
    userDrive.filePath = filePath.length === 0 ? null : filePath.join(',');
    await this.userDriveRepository.save(userDrive);

    return;
  }

  async reply(user: ILoginUserInfo, getBody: UserDriveReplyReqDto) {
    const { id, replyContent } = getBody;

    const userDrive = await this.userDriveRepository.findOne({
      where: {
        id,
      },
    });

    if (!userDrive) {
      throw new BadRequestException('문서가 존재하지 않습니다.');
    }

    userDrive.replyContent = replyContent;

    await this.userDriveRepository.save(userDrive);
    return;
  }

  async delete(user: ILoginUserInfo, id: number) {
    if (user.authority === 'CORPORATE_ADMIN') {
      throw new BadRequestException('관리자만 접근 가능합니다.');
    }

    const userDrive = await this.userDriveRepository.findOne({
      where: {
        id,
      },
    });

    if (!userDrive) {
      throw new BadRequestException('문서가 존재하지 않습니다.');
    }

    if (user.authority === IUserAuthority.OPERATION_ADMIN && userDrive.senderId !== user.id) {
      throw new ForbiddenException();
    }

    await this.userDriveRepository.softDelete(id);
    return;
  }
}
