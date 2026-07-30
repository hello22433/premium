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
      fileUrlList.map(async (url, index) => {
        try {
          const name =
            index < UserDriveService.MAX_FILE_META_LOOKUP
              ? await this.fileService.getOriginalName(url)
              : this.fileService.extractOriginalFileName(url);
          return { url, name };
        } catch {
          // 잘못된/레거시 항목(비URL·콤마분할 조각 등)의 이름 조회가 실패해도 상세 전체를 500 내지 않도록 폴백.
          // 원본명 조회는 표시용이라, 한 항목이 깨져도 마지막 경로조각(없으면 원문)으로 degrade 한다.
          return { url, name: url.split('/').pop() || url };
        }
      }),
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
   *  - 객체 소유 검증(assertDownloadable): 첨부 소유를 문서 "글쓰기 권한"과 통일한다 — 관리자 아닌
   *    요청자(기업 수신자)에겐 ownerId 가 발신자이거나 SUPER 인 첨부만 허용(글 쓸 수 있던 사람이 넣은 것만).
   *    filePath 는 신뢰 불가하므로 key 소유까지 검증한다. ※ 주문접수와 달리 정당한 다운로더가
   *    수신자(≠업로더)라 요청자 id 로 비교하지 않는다.
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

    await this.assertDownloadable(fileUrl, userDrive, user);

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

  /**
   * 문서 읽기 권한 — 관리자 전체 / 기업관리자는 본인이 수신자이고 DRAFT 아님(상세조회와 동일 규칙).
   * 권한 밖일 때는 Forbidden 이 아니라 "문서 없음"(BadRequest)으로 응답한다: getDetail 이 수신자 조건을
   * where 에 넣어 존재 여부를 숨기는 것과 동일하게, 다운로드에서도 남의 문서 id 존재가 새지 않게 통일.
   */
  private assertCanReadDrive(user: ILoginUserInfo, drive: UserDriveEntity) {
    if (this.isAdminUser(user)) {
      return;
    }

    if (
      user.authority !== IUserAuthority.CORPORATE_ADMIN ||
      drive.receiverId !== user.id ||
      drive.status === IUserDriveStatus.DRAFT
    ) {
      throw new BadRequestException('문서가 존재하지 않습니다.');
    }
  }

  /**
   * 클라이언트가 filePath 에 임의 URL/key 를 심어 백엔드 자격증명으로 타인 객체를 우회 read 하는 것을 차단.
   *  - host: 우리 S3 버킷 URL 이 아니면 차단.
   *  - private/{ownerId}/... : 첨부 소유(ownerId) 검증을 문서함 "글쓰기(수정) 권한"과 통일한다.
   *    문서함 첨부는 그 문서에 글 쓸 수 있는 사람만 넣을 수 있고(create/update 관리자 전용),
   *    글쓰기 권한은 = 발신자 본인(OPERATION_ADMIN) 또는 최고관리자(SUPER_ADMIN, 아무 문서나 수정 가능)다.
   *    따라서 관리자 아닌 요청자(기업 수신자)에겐 ownerId 가 발신자이거나 SUPER 인 첨부만 허용한다.
   *      · ownerId === senderId  → 발신자가 올린 첨부(대다수). 조회 없이 통과.
   *      · 그 외               → SUPER 가 교차수정으로 올린 경우만 허용(그래서 업로더 권한을 조회해 확인).
   *    이렇게 하면 발신 아닌 다른 운영관리자/기업계정의 key 가 심겨도 차단되면서, SUPER 교차수정은 과차단하지 않는다.
   *    ownerId 세그먼트가 없는 구 private key 는 문서함 첨부가 아니므로 차단(NaN → Forbidden).
   *  - image/ · file/ : 전환 전 공개 첨부 호환용으로만 허용. 문서함 레거시 첨부는 /file/image(→ image/)로
   *    올라갔고, 과거 일반 업로드는 /file/upload(→ file/)다. 둘 다 public-read 라 프록시로 서빙해도
   *    위험도 동일(오히려 문서 열람권한이 추가로 걸림). 그 외 위치는 차단.
   */
  private async assertDownloadable(fileUrl: string, drive: UserDriveEntity, user: ILoginUserInfo): Promise<void> {
    if (!this.fileService.isOwnStorageUrl(fileUrl)) {
      throw new ForbiddenException('다운로드할 수 없는 파일입니다.');
    }

    const key = this.fileService.extractStorageKey(fileUrl);

    if (key.startsWith('private/')) {
      const ownerSegment = key.split('/')[1] ?? '';
      // ownerId 세그먼트는 10진 숫자여야 한다. Number('')===0, Number('0x10')===16 등이 Number.isInteger 를
      // 통과하는 모호함을 없애기 위해 정규식으로 명시 검증(문서함 첨부 key 규격: private/{decimal-id}/...).
      if (!/^\d+$/.test(ownerSegment)) {
        throw new ForbiddenException('다운로드할 수 없는 파일입니다.');
      }
      const ownerId = Number(ownerSegment);
      // 요청자가 관리자면 전체 허용. 그 외엔 "이 문서에 글 쓸 수 있던 사람이 올린 첨부"만 허용:
      // 발신자 본인이면 즉시 통과, 아니면 업로더가 SUPER 인 경우(아무 문서나 수정 가능)만 예외 허용.
      if (!this.isAdminUser(user) && ownerId !== drive.senderId) {
        const uploader = await this.userRepository.findOne({ where: { id: ownerId } });
        if (uploader?.authority !== IUserAuthority.SUPER_ADMIN) {
          throw new ForbiddenException('다운로드 권한이 없습니다.');
        }
      }
      return;
    }

    // 레거시 공개 첨부 호환: 문서함은 image/(‥/file/image), 과거 일반 업로드는 file/. 둘 다 public-read.
    if (key.startsWith('image/') || key.startsWith('file/')) {
      return;
    }

    throw new ForbiddenException('다운로드할 수 없는 파일입니다.');
  }

  /**
   * 넣을 때(쓰기) 검증 — 새로 추가되는 첨부만 대상. confused-deputy(운영자가 남의 private URL 을
   * 문서에 심어 수신자에게 유출)를 소스에서 차단해, 읽기(assertDownloadable)와 이중방어를 이룬다.
   *  - private/{ownerId}/ : ownerId 가 등록자 본인이어야 함(본인이 올린 것만 첨부 가능).
   *  - image/·file/ : 공개(public-read) 레거시 → 심어도 유출이 아니고(이미 공개), FE 전환 전 현행
   *    문서함이 /file/image(→ image/)로 올리므로 호환 위해 허용.
   *  - 그 외 위치·외부 host : 차단.
   * ※ 기존에 이미 문서에 있던 첨부는 재검증하지 않는다(SUPER 가 교차수정으로 남긴 타인 소유 첨부,
   *   또는 발신자 소유 첨부를 SUPER 가 재저장할 때 보존하기 위함).
   */
  private assertNewAttachmentsOwnedBySelf(newUrls: string[], user: ILoginUserInfo): void {
    for (const url of newUrls) {
      if (!this.fileService.isOwnStorageUrl(url)) {
        throw new BadRequestException('허용되지 않은 파일 경로입니다.');
      }
      const key = this.fileService.extractStorageKey(url);

      if (key.startsWith('private/')) {
        const ownerSegment = key.split('/')[1] ?? '';
        if (!/^\d+$/.test(ownerSegment) || Number(ownerSegment) !== user.id) {
          throw new BadRequestException('본인이 업로드한 첨부만 등록할 수 있습니다.');
        }
        continue;
      }
      if (key.startsWith('image/') || key.startsWith('file/')) {
        continue; // 공개 레거시: 심어도 유출 아님(이미 public), 전환 전 호환
      }
      throw new BadRequestException('허용되지 않은 파일 경로입니다.');
    }
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

    // 생성 시 첨부는 전부 신규 → 전량 검증(본인 업로드 private 또는 공개 레거시만).
    this.assertNewAttachmentsOwnedBySelf(filePath, user);

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

    // 새로 추가된 첨부만 검증(기존 목록에 없던 것). 기존 첨부는 보존 — SUPER 가 교차수정 시
    // 발신자/타관리자 소유 첨부를 되보내도 통과해야 하므로 델타만 본다.
    const existingUrls = parseFilePathList(userDrive.filePath);
    const addedUrls = filePath.filter((url) => !existingUrls.includes(url));
    this.assertNewAttachmentsOwnedBySelf(addedUrls, user);

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
