import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fs from 'node:fs';
import {
  isFilePathListRoundTripSafe,
  maskStorageKeyForLog,
  parseFilePathList,
  sanitizeForLog,
} from '../../util/file.util';
import { InjectRepository } from '@nestjs/typeorm';
import { UserDriveEntity } from '../../entity/user.drive.entity';
import { In, Repository } from 'typeorm';
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
  private readonly logger = new Logger(UserDriveService.name);

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
    // ★ HeadObject 대상은 '다운로드를 허용하는 것' 과 같은 기준으로 좁힌다(resolveHeadableUrls 참조).
    const headableUrls = await this.resolveHeadableUrls(fileUrlList, userDrive.senderId);
    // 원본 파일명(메타데이터)까지 함께 — FE 가 화면 표시·다운로드명 모두 진짜 이름으로 일관되게.
    // S3 HeadObject 는 상한(MAX_FILE_META_LOOKUP)까지만 — 초과분은 key 복원 폴백(호출 폭주 방지).
    const files = await Promise.all(
      fileUrlList.map(async (url, index) => {
        try {
          // 원본명 메타데이터는 private 업로드에만 붙는다 → 레거시(image//file/)는 HeadObject 헛호출을
          // 건너뛰고 key 복원으로 바로 간다. private 도 상한(MAX_FILE_META_LOOKUP)까지만 HeadObject.
          const useHead = headableUrls.has(url) && index < UserDriveService.MAX_FILE_META_LOOKUP;
          const name = useHead
            ? await this.fileService.getOriginalName(url)
            : this.fileService.extractOriginalFileName(url);
          return { url, name };
        } catch (error) {
          // 여기 오는 건 사실상 key 파싱 실패(비URL·콤마분할 조각)뿐이다 — S3 오류는 한 층 아래
          // FileService.getOriginalName 이 이미 잡아 key 복원으로 폴백하므로 여기까지 올라오지 않는다.
          // 상세 전체를 500 내지 않도록 폴백하되, 조용히 넘기지 않게 남긴다.
          // uuid 접두사를 벗겨(첫 '-' 뒤) extractOriginalFileName 과 표시 일관성을 맞춘다.
          this.logger.warn(
            `첨부 이름 조립 실패 — key 복원으로 폴백 (driveId=${userDrive.id}, index=${index}): ${
              (error as Error)?.message ?? String(error)
            }`,
          );
          const base = url.split('/').pop() || url;
          return { url, name: base.includes('-') ? base.split('-').slice(1).join('-') : base };
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
   *  - 객체 소유 검증(assertDownloadable): 첨부 소유를 문서 "글쓰기 권한"과 통일한다 — 요청자 권한과
   *    무관하게 ownerId 가 발신자이거나 업로더가 SUPER 인 첨부만 허용(글 쓸 수 있던 사람이 넣은 것만).
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

  /**
   * 상세조회에서 S3 HeadObject(원본명 조회) 를 걸어도 되는 첨부만 골라낸다.
   *
   * ★ 왜 좁히나 — HeadObject 는 '그 key 의 진짜 원본 파일명' 을 응답(files[].name)에 실어준다.
   *   즉 다운로드를 안 해도 이름은 새어나간다. 그래서 객체 판정은 다운로드 허용 규칙
   *   (assertDownloadable: 발신자 소유이거나 업로더가 SUPER)과 같은 기준을 쓴다.
   *
   * ※ 한때 assertDownloadable 에만 "요청자가 관리자면 소유검사 생략" 이 있어 두 판정이 갈렸으나,
   *   그 우회가 과거에 저장된 타인 소유 private key 를 관리자 경로로 열어 주는 구멍이라 제거했다.
   *   지금은 두 함수가 같은 객체 판정을 쓴다 — 어느 한쪽에만 요청자 권한 우회를 얹지 마라.
   *
   *   쓰기 시점 검증이 생긴 뒤로 타인 소유 key 가 새로 들어올 길은 막혔지만, 그 이전에 저장된 행은
   *   그대로 남아 있으므로 읽는 쪽에도 같은 판정을 둔다(이중 방어).
   *
   * 우리 버킷이 아니거나 key 파싱이 실패하면 대상에서 뺀다 — 임의 host 의 pathname 을 우리 버킷 key 로
   * 오인해 조회(객체 존재 여부 탐지)하는 통로가 되지 않게.
   * 레거시 공개(image//file/) 는 애초에 메타데이터가 없어 대상이 아니다(헛호출 제거, 기존 동작 유지).
   *
   * 대상에서 빠진 첨부는 차단이 아니라 key 복원 이름으로 표시된다(sanitize 되어 공백이 _ 로 보일 수 있음).
   */
  private async resolveHeadableUrls(fileUrlList: string[], senderId: number): Promise<Set<string>> {
    const candidates: { url: string; ownerId: number }[] = [];
    for (const url of fileUrlList) {
      if (!this.fileService.isOwnStorageUrl(url)) continue;
      const key = this.tryExtractStorageKey(url);
      if (key === null || !key.startsWith('private/')) continue;
      const ownerSegment = key.split('/')[1] ?? '';
      if (!/^[0-9]+$/.test(ownerSegment)) continue;
      candidates.push({ url, ownerId: Number(ownerSegment) });
    }

    const headable = new Set(candidates.filter((c) => c.ownerId === senderId).map((c) => c.url));

    // 발신자 소유가 아닌 것만 업로더 권한을 확인한다(SUPER 교차수정 첨부 허용). 조회는 1회로 묶는다.
    const foreignOwnerIds = [...new Set(candidates.filter((c) => c.ownerId !== senderId).map((c) => c.ownerId))];
    if (foreignOwnerIds.length === 0) {
      return headable;
    }

    // ★ 축을 나눠서 처리한다 — 보안축은 fail-closed(권한을 '확인 못 함' 은 '허용' 이 아니다 → 대상에서 뺀다),
    //   가용성축은 fail-soft(문서 열람 자체는 막지 않는다). 이 조회는 '이름을 예쁘게 보여줄지' 를 정하는
    //   곁가지인데, 던지게 두면 제목·본문·답변까지 못 보는 500 이 된다(나머지 이름 조회는 전부 fail-soft 다).
    //   조용히 열화되면 아무도 모르므로 반드시 남긴다.
    let superAdminIds: Set<number>;
    try {
      const superAdmins = await this.userRepository.find({
        where: { id: In(foreignOwnerIds), authority: IUserAuthority.SUPER_ADMIN },
        select: ['id'],
      });
      superAdminIds = new Set(superAdmins.map((u) => u.id));
    } catch (error) {
      this.logger.warn(
        `첨부 업로더 권한 조회 실패 — 원본명 조회를 생략하고 key 복원으로 표시 (ownerIds=${foreignOwnerIds.join(
          ',',
        )}): ${(error as Error)?.message ?? String(error)}`,
      );
      return headable;
    }
    for (const c of candidates) {
      if (c.ownerId !== senderId && superAdminIds.has(c.ownerId)) headable.add(c.url);
    }
    return headable;
  }

  /**
   * 첨부 소유·경로 검증에서 거절한 사실을 남긴다.
   *
   * ★ 왜 필요한가 — 이 기능이 막으려는 것(남의 private key 를 문서에 심어 수신자에게 흘리는 것)은
   *   막히면 400/403 으로 끝나고 앱 로그엔 한 줄도 안 남았다. 게다가 같은 작업에서 접근 로그의
   *   filePath/fileUrl 을 *** 로 가렸기 때문에, "무슨 key 를 노렸나" 를 되짚을 마지막 흔적까지 사라졌다.
   *   → 시도 자체를 여기서 남긴다. 반복 시도인지 오타인지도 이걸로만 갈린다.
   * ※ 남기는 것은 내부 id 와 마스킹된 key 뿐이다 — 원본 파일명은 남지 않는다(maskStorageKeyForLog).
   * ★ 값 정제를 이 함수 안에서 끝낸다. 넘어오는 값 중 ownerSegment 는 key 를 split 한 조각이라
   *   클라이언트가 정하는 문자열이고, key 는 decodeURIComponent 를 지나서 `%0a` 가 실제 개행이 된다.
   *   게다가 이 로그는 정규식을 '통과 못 했을 때' 찍히므로 개행이 든 세그먼트는 항상 여기로 온다.
   *   호출부 9곳에서 각각 감싸게 두면 한 곳이 빠진다 — maskStorageKeyForLog 가 겪은 그대로다.
   */
  private warnAttachmentRejected(reason: string, context: Record<string, string | number>): void {
    const detail = Object.entries(context)
      .map(([key, value]) => `${key}=${sanitizeForLog(String(value))}`)
      .join(', ');
    this.logger.warn(`첨부 검증 거절 — ${reason} (${detail})`);
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
   *    따라서 ownerId 가 발신자이거나 SUPER 인 첨부만 허용한다(요청자가 관리자여도 동일하게 건다).
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
      this.warnAttachmentRejected('다운로드: 우리 버킷 URL 이 아님', {
        driveId: drive.id,
        requesterId: user.id,
      });
      throw new ForbiddenException('다운로드할 수 없는 파일입니다.');
    }

    // key 파싱은 실패할 수 있다 — new URL 은 통과하지만 pathname 에 깨진 percent-encoding(예: `/private/5/%`)
    // 이 있으면 decodeURIComponent 가 URIError 를 던진다. 감싸지 않으면 클라이언트 입력 문제가 500 으로 나간다.
    const key = this.tryExtractStorageKey(fileUrl);
    if (key === null) {
      this.warnAttachmentRejected('다운로드: key 파싱 실패', { driveId: drive.id, requesterId: user.id });
      throw new ForbiddenException('다운로드할 수 없는 파일입니다.');
    }

    if (key.startsWith('private/')) {
      const ownerSegment = key.split('/')[1] ?? '';
      // ownerId 세그먼트는 10진 숫자여야 한다. Number('')===0, Number('0x10')===16 등이 Number.isInteger 를
      // 통과하는 모호함을 없애기 위해 정규식으로 명시 검증(문서함 첨부 key 규격: private/{decimal-id}/...).
      if (!/^\d+$/.test(ownerSegment)) {
        this.warnAttachmentRejected('다운로드: private key 에 ownerId 세그먼트가 없음', {
          driveId: drive.id,
          requesterId: user.id,
          key: maskStorageKeyForLog(key),
        });
        throw new ForbiddenException('다운로드할 수 없는 파일입니다.');
      }
      const ownerId = Number(ownerSegment);
      // "이 문서에 글 쓸 수 있던 사람이 올린 첨부" 만 허용한다 — 발신자 본인이면 즉시 통과,
      // 아니면 업로더가 SUPER 인 경우(아무 문서나 수정 가능)만 예외 허용.
      // ★ 요청자가 관리자여도 건너뛰지 않는다. 관리자는 '문서를 볼 권한' 이 넓은 것이지
      //   '아무 S3 객체나 백엔드 자격증명으로 받을 권한' 이 넓은 게 아니다. 쓰기 시점 검증은 앞으로
      //   들어올 것만 막으므로, 그 이전에 저장된 타인 소유 private key 가 남아 있으면 관리자 경로로
      //   그대로 내려받힌다 → 객체 판정은 요청자 권한과 무관하게 건다(resolveHeadableUrls 와 동일).
      if (ownerId !== drive.senderId) {
        const uploader = await this.userRepository.findOne({
          where: { id: ownerId },
          select: ['id', 'authority'],
        });
        if (uploader?.authority !== IUserAuthority.SUPER_ADMIN) {
          this.warnAttachmentRejected('다운로드: 발신자 소유도 SUPER 업로드도 아닌 첨부', {
            driveId: drive.id,
            requesterId: user.id,
            senderId: drive.senderId,
            ownerId,
            key: maskStorageKeyForLog(key),
          });
          throw new ForbiddenException('다운로드 권한이 없습니다.');
        }
      }
      return;
    }

    // 레거시 공개 첨부 호환: 문서함은 image/(‥/file/image), 과거 일반 업로드는 file/. 둘 다 public-read.
    if (key.startsWith('image/') || key.startsWith('file/')) {
      return;
    }

    this.warnAttachmentRejected('다운로드: 허용되지 않은 key 위치', {
      driveId: drive.id,
      requesterId: user.id,
      key: maskStorageKeyForLog(key),
    });
    throw new ForbiddenException('다운로드할 수 없는 파일입니다.');
  }

  /**
   * 저장(join(',')) → 복원(parseFilePathList) 왕복이 입력 배열을 그대로 보존하는지 검증한다.
   *
   * 보존되지 않으면 "검증한 것"과 "저장되는 것"이 달라진다 — 배열 원소 하나에 `,https://...` 를 심으면
   * 소유 검증은 URL 1개(본인 소유)로 보고 통과시키지만, 저장 후에는 2개로 복원돼 검증을 거치지 않은
   * 타인 소유 private 객체가 첨부로 들어온다(개수 상한도 함께 우회).
   * 읽는 쪽(assertDownloadable)이 소유를 다시 보므로 대부분 거기서 막히지만, 밀반입한 업로더가 SUPER 면
   * 그 판정을 통과해 기업 수신자에게까지 내려간다. 그래서 쓰는 쪽에서 먼저 막는다.
   * ※ 한때 여기 "관리자 다운로드는 소유 검사를 건너뛴다" 고 적혀 있었으나 그 우회는 제거됐다
   *   (assertDownloadable 참조). 되살리지 마라.
   *
   * 파일명에 정상적으로 콤마가 든 경우는 왕복이 보존되므로 이 검사에 걸리지 않는다.
   */
  private toStoredFilePath(filePath: string[]): string | null {
    if (!isFilePathListRoundTripSafe(filePath)) {
      throw new BadRequestException('첨부 경로 형식이 올바르지 않습니다.');
    }
    return filePath.length === 0 ? null : filePath.join(',');
  }

  /**
   * URL → S3 key. 파싱 실패(깨진 percent-encoding 등)는 예외 대신 null 로 돌려 호출부가 상태코드를 정한다.
   *
   * ★ 노리는 실패는 둘뿐이다 — new URL 의 TypeError, decodeURIComponent 의 URIError. 그 둘은 클라이언트
   *   입력 문제라 조용히 null 이 맞다. 하지만 전부 삼키면 이 함수가 하는 일이 늘었을 때 새 원인의 실패가
   *   소리 없이 '권한 없음' 으로 둔갑한다. 그래서 예상 밖 예외만 남긴다.
   */
  private tryExtractStorageKey(fileUrl: string): string | null {
    try {
      return this.fileService.extractStorageKey(fileUrl);
    } catch (error) {
      const name = (error as Error)?.name;
      if (name !== 'TypeError' && name !== 'URIError') {
        this.logger.warn(`첨부 key 파싱이 예상 밖 이유로 실패: ${sanitizeForLog(name ?? String(error))}`);
      }
      return null;
    }
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
        this.warnAttachmentRejected('등록: 우리 버킷 URL 이 아님', { requesterId: user.id });
        throw new BadRequestException('허용되지 않은 파일 경로입니다.');
      }
      const key = this.tryExtractStorageKey(url);
      if (key === null) {
        this.warnAttachmentRejected('등록: key 파싱 실패', { requesterId: user.id });
        throw new BadRequestException('허용되지 않은 파일 경로입니다.');
      }

      if (key.startsWith('private/')) {
        const ownerSegment = key.split('/')[1] ?? '';
        if (!/^\d+$/.test(ownerSegment) || Number(ownerSegment) !== user.id) {
          this.warnAttachmentRejected('등록: 본인이 올리지 않은 private 첨부', {
            requesterId: user.id,
            ownerSegment,
            key: maskStorageKeyForLog(key),
          });
          throw new BadRequestException('본인이 업로드한 첨부만 등록할 수 있습니다.');
        }
        continue;
      }
      if (key.startsWith('image/') || key.startsWith('file/')) {
        continue; // 공개 레거시: 심어도 유출 아님(이미 public), 전환 전 호환
      }
      this.warnAttachmentRejected('등록: 허용되지 않은 key 위치', {
        requesterId: user.id,
        key: maskStorageKeyForLog(key),
      });
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
    const storedFilePath = this.toStoredFilePath(filePath);

    await this.userDriveRepository.insert({
      senderId: user.id,
      receiverId: receiver.id,
      title,
      content,
      sendAt: new Date(),
      status: status ?? IUserDriveStatus.REGISTER,
      filePath: storedFilePath,
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
    userDrive.filePath = this.toStoredFilePath(filePath);
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
