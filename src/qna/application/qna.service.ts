import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { parseFilePathList } from '../../util/file.util';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { QnaEntity } from '../../entity/qna.entity';
import { UserEntity } from '../../entity/user.entity';
import {
  QnaAnswerReqDto,
  QnaBulkDeleteReqDto,
  QnaCreateReqDto,
  QnaDeleteReqParamDto,
  QnaGetDetailReqParamDto,
  QnaGetListReqDto,
  QnaUpdateAnswerReqDto,
} from '../api/qna.req.dto';
import {
  QnaBulkDeleteResDto,
  QnaGetDetailResDto,
  QnaGetListResDto,
  QnaGetMyQnaHistoryResDto,
} from '../api/qna.res.dto';
import { QnaViewDto } from '../api/dto/qna.view.dto';
import { format } from 'date-fns';
import { DateDateFormatStr } from '../../common/domain/date.format.str';
import { IQnaStatus } from '../interface/qna.status';
import { IQnaMainCategory, QnaMainCategoryKo, QnaSubCategoryKo } from '../interface/qna.category';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { FindOptionsWhere } from 'typeorm/find-options/FindOptionsWhere';
import { IUserAuthority } from '../../user/interface/user.authority';

@Injectable()
export class QnaService {
  constructor(
    @InjectRepository(QnaEntity)
    private qnaRepository: Repository<QnaEntity>,
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
  ) {}

  /**
   * 문의 작성자 표시값(담당자명·회사명) 결정.
   * 스냅샷이 기록된 행(판별자 snapshotPersonName != null)은 작성 당시 값으로 동결,
   * 스냅샷 도입 이전 레거시 행은 user FK join 결과로 fallback 한다.
   * (연락처 email/phone 은 정책상 동결하지 않고 항상 live 로 노출)
   */
  private resolveAuthorDisplay(qna: QnaEntity): { personName: string; businessName: string } {
    if (qna.snapshotPersonName != null) {
      return {
        personName: qna.snapshotPersonName,
        businessName: qna.snapshotBusinessName ?? '',
      };
    }
    return {
      personName: qna.user?.personName ?? '',
      businessName: qna.user?.company?.businessName ?? '',
    };
  }

  async getList(user: ILoginUserInfo, getQuery: QnaGetListReqDto): Promise<QnaGetListResDto> {
    const { page, take, mainCategory } = getQuery;

    const whereCondition: FindOptionsWhere<QnaEntity> = {};

    if (user.authority === 'CORPORATE_ADMIN') {
      whereCondition.userId = user.id;
    }

    if (mainCategory) {
      whereCondition.mainCategory = mainCategory;
    }

    const skip = (page - 1) * take;

    const [qnaList, totalCount] = await this.qnaRepository.findAndCount({
      where: whereCondition,
      order: { id: 'DESC' },
      take,
      skip,
      relations: ['user', 'user.company'],
    });

    const totalPage = Math.ceil(totalCount / take);

    const resultList: QnaViewDto[] = qnaList.map((qna) => {
      const isFile = !!qna.filePath;
      const isAnswer = !!qna.answer;
      const display = this.resolveAuthorDisplay(qna);

      return {
        id: qna.id,
        registerDate: format(qna.createdAt, 'yyyy-MM-dd HH:mm'),
        businessName: display.businessName,
        personName: display.personName,
        title: qna.title,
        isFile,
        isAnswer,
        mainCategory: qna.mainCategory,
        mainCategoryKo: QnaMainCategoryKo[qna.mainCategory],
      };
    });

    return {
      list: resultList,
      totalCount,
      currentPage: page,
      totalPage,
    };
  }

  async getDetail(user: ILoginUserInfo, getParam: QnaGetDetailReqParamDto): Promise<QnaGetDetailResDto> {
    const { id } = getParam;

    const qna = await this.qnaRepository.findOne({
      where: {
        id,
      },
      relations: ['user', 'user.company'],
    });

    if (!qna) {
      throw new BadRequestException('1대1 문의가 존재하지 않습니다.');
    }

    if (user.authority === IUserAuthority.CORPORATE_ADMIN && qna.userId !== user.id) {
      throw new ForbiddenException();
    }

    const display = this.resolveAuthorDisplay(qna);

    return {
      id: qna.id,
      registerDate: format(qna.registerDate, DateDateFormatStr),
      businessName: display.businessName,
      personName: display.personName,
      userEmail: qna.user?.email ?? '',
      userPhone: qna.user?.personPhoneNumber ?? '',
      status: qna.status,
      filePathList: parseFilePathList(qna.filePath),
      title: qna.title,
      content: qna.content,
      answer: qna.answer ?? null,
      mainCategory: qna.mainCategory,
      mainCategoryKo: QnaMainCategoryKo[qna.mainCategory],
      subCategory: qna.subCategory,
      subCategoryKo: qna.subCategory ? QnaSubCategoryKo[qna.subCategory] : null,
    };
  }

  async answer(user: ILoginUserInfo, getBody: QnaAnswerReqDto) {
    const { id, answer } = getBody;

    if (user.authority === 'CORPORATE_ADMIN') {
      throw new BadRequestException('관리자만 접근 가능합니다.');
    }

    const qna = await this.qnaRepository.findOne({
      where: {
        id,
      },
    });

    if (!qna) {
      throw new BadRequestException('1대1 문의가 존재하지 않습니다.');
    }

    await this.qnaRepository.update(
      {
        id: qna.id,
      },
      {
        answer,
        status: IQnaStatus.OK,
      },
    );
  }

  async update(user: ILoginUserInfo, getBody: QnaUpdateAnswerReqDto) {
    const { id, answer } = getBody;

    if (user.authority === IUserAuthority.CORPORATE_ADMIN) {
      throw new ForbiddenException('관리자만 접근 가능합니다.');
    }

    const qna = await this.qnaRepository.findOne({
      where: {
        id,
      },
    });

    if (!qna) {
      throw new BadRequestException('1대1 문의가 존재하지 않습니다.');
    }

    await this.qnaRepository.update(
      {
        id: qna.id,
      },
      {
        answer,
      },
    );
  }

  async create(user: ILoginUserInfo, getBody: QnaCreateReqDto) {
    const { content, filePathList, title, mainCategory, subCategory } = getBody;

    if (user.authority !== 'CORPORATE_ADMIN') {
      throw new BadRequestException('기업관리자 회원만 1대1 문의를 작성할 수 있습니다.');
    }

    if (mainCategory === IQnaMainCategory.CS && !subCategory) {
      throw new BadRequestException('CS접수 시 상세항목을 선택해주세요.');
    }

    // 작성 시점 담당자명·회사명 스냅샷 (계정관리에서 담당자명 변경돼도 과거 문의는 당시 값 유지)
    const author = await this.userRepository.findOneOrFail({
      where: { id: user.id },
      relations: ['company'],
    });

    await this.qnaRepository.insert({
      userId: user.id,
      title,
      content,
      filePath: filePathList.length !== 0 ? filePathList.join(',') : null,
      registerDate: format(new Date(), DateDateFormatStr),
      status: IQnaStatus.WAIT,
      mainCategory,
      subCategory: subCategory ?? null,
      snapshotPersonName: author.personName,
      snapshotBusinessName: author.company?.businessName ?? null,
    });
  }

  async getMyQnaHistory(user: ILoginUserInfo): Promise<QnaGetMyQnaHistoryResDto> {
    const waitWhere: FindOptionsWhere<QnaEntity> = { status: IQnaStatus.WAIT };
    const completeWhere: FindOptionsWhere<QnaEntity> = { status: IQnaStatus.OK };

    if (user.authority === IUserAuthority.CORPORATE_ADMIN) {
      waitWhere.userId = user.id;
      completeWhere.userId = user.id;
    }

    const [waitCount, completeCount] = await Promise.all([
      this.qnaRepository.count({ where: waitWhere }),
      this.qnaRepository.count({ where: completeWhere }),
    ]);

    return {
      tempCount: 0, // TODO
      waitCount,
      completeCount,
      deadlineCount: 0, // TODO
    };
  }

  async deleteOne(getParam: QnaDeleteReqParamDto): Promise<void> {
    const { id } = getParam;

    const qna = await this.qnaRepository.findOne({ where: { id } });

    if (!qna) {
      throw new BadRequestException('1대1 문의가 존재하지 않습니다.');
    }

    await this.qnaRepository.softDelete({ id });
  }

  async deleteMany(getBody: QnaBulkDeleteReqDto): Promise<QnaBulkDeleteResDto> {
    const { ids } = getBody;

    const existingList = await this.qnaRepository.find({
      where: { id: In(ids) },
      select: ['id'],
    });
    const existingIds = existingList.map((qna) => qna.id);

    if (existingIds.length === 0) {
      return { deletedCount: 0, deletedIds: [] };
    }

    await this.qnaRepository.softDelete({ id: In(existingIds) });

    return {
      deletedCount: existingIds.length,
      deletedIds: existingIds,
    };
  }
}
