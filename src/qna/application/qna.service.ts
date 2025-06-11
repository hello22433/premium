import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { QnaEntity } from '../../entity/qna.entity';
import {
  QnaAnswerReqDto,
  QnaCreateReqDto,
  QnaGetDetailReqParamDto,
  QnaGetListReqDto,
  QnaUpdateAnswerReqDto,
} from '../api/qna.req.dto';
import { QnaGetDetailResDto, QnaGetListResDto, QnaGetMyQnaHistoryResDto } from '../api/qna.res.dto';
import { QnaViewDto } from '../api/dto/qna.view.dto';
import { format } from 'date-fns';
import { DateDateFormatStr } from '../../common/domain/date.format.str';
import { IQnaStatus } from '../interface/qna.status';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { FindOptionsWhere } from 'typeorm/find-options/FindOptionsWhere';
import { IUserAuthority } from '../../user/interface/user.authority';

@Injectable()
export class QnaService {
  constructor(
    @InjectRepository(QnaEntity)
    private qnaRepository: Repository<QnaEntity>,
  ) {}

  async getList(user: ILoginUserInfo, getQuery: QnaGetListReqDto): Promise<QnaGetListResDto> {
    const { page, take } = getQuery;

    const whereCondition: FindOptionsWhere<QnaEntity> = {};

    if (user.authority === 'CORPORATE_ADMIN') {
      whereCondition.userId = user.id;
    }

    const skip = (page - 1) * take;

    const [qnaList, totalCount] = await this.qnaRepository.findAndCount({
      where: whereCondition,
      order: { id: 'DESC' },
      take,
      skip,
      relations: ['user'],
    });

    const totalPage = Math.ceil(totalCount / take);

    const resultList: QnaViewDto[] = qnaList.map((qna) => {
      const isFile = !!qna.filePath;
      const isAnswer = !!qna.answer;

      return {
        id: qna.id,
        registerDate: format(qna.createdAt, DateDateFormatStr),
        businessName: qna.user.businessName,
        personName: qna.user.personName,
        title: qna.title,
        isFile,
        isAnswer,
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
      relations: ['user'],
    });

    if (!qna) {
      throw new BadRequestException('1대1 문의가 존재하지 않습니다.');
    }

    return {
      id: qna.id,
      registerDate: format(qna.registerDate, DateDateFormatStr),
      businessName: qna.user.businessName,
      personName: qna.user.personName,
      userEmail: qna.user.email,
      userPhone: qna.user.personPhoneNumber,
      status: qna.status,
      filePathList: qna.filePath ? qna.filePath.split(',') : [],
      title: qna.title,
      content: qna.content,
      answer: qna.answer ?? null,
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

    // if (user.authority === 'CORPORATE_ADMIN') {
    //   throw new BadRequestException('관리자만 접근 가능합니다.');
    // }

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
    const { content, filePathList, title } = getBody;

    if (user.authority !== 'CORPORATE_ADMIN') {
      throw new BadRequestException('기업관리자 회원만 1대1 문의를 작성할 수 있습니다.');
    }

    await this.qnaRepository.insert({
      userId: user.id,
      title,
      content,
      filePath: filePathList.length !== 0 ? filePathList.join(',') : null,
      registerDate: format(new Date(), DateDateFormatStr),
      status: IQnaStatus.WAIT,
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
}
