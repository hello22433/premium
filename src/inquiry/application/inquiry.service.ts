import { BadRequestException, Injectable } from '@nestjs/common';
import { InquiryEntity } from '../../entity/inquiry.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  InquiryCreateReqDto,
  InquiryGetDetailReqParamDto,
  InquiryGetListReqQueryDto,
  InquiryReplyReqDto,
} from '../api/inquiry.req.dto';
import { InquiryGetDetailResDto, InquiryGetListResDto } from '../api/inquiry.res.dto';
import { InquiryViewDto } from '../api/dto/inquiry.view.dto';
import { DateFormatStr } from '../../common/domain/date.format.str';
import { format } from 'date-fns';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { InquiryStatus } from '../interface/inquiry.status';

@Injectable()
export class InquiryService {
  constructor(
    @InjectRepository(InquiryEntity)
    private inquiryRepository: Repository<InquiryEntity>,
  ) {}

  async getList(getQuery: InquiryGetListReqQueryDto): Promise<InquiryGetListResDto> {
    const { take, page } = getQuery;

    let queryBuilder = this.inquiryRepository
      .createQueryBuilder('inquiry')
      .innerJoinAndSelect('inquiry.user', 'user')
      .leftJoinAndSelect('user.company', 'company');

    const skip = (page - 1) * take;

    queryBuilder = queryBuilder.take(take).skip(skip);

    const [inquiryList, totalCount] = await queryBuilder.getManyAndCount();

    const resultList: InquiryViewDto[] = inquiryList.map((inquiry) => {
      return {
        id: inquiry.id,
        createdAt: format(inquiry.createdAt, DateFormatStr),
        userBusinessName: inquiry.user.company?.businessName ?? '',
        userPersonName: inquiry.user.personName,
        title: inquiry.title,
        isFilePath: !!inquiry.filePath,
        isAnswer: !!inquiry.replyContent,
      };
    });

    const totalPage = Math.ceil(totalCount / take);

    return {
      list: resultList,
      totalCount,
      totalPage,
      currentPage: page,
    };
  }

  async getDetail(getParam: InquiryGetDetailReqParamDto): Promise<InquiryGetDetailResDto> {
    const { id } = getParam;

    const inquiry = await this.inquiryRepository.findOne({
      where: {
        id: id,
      },
      relations: ['user', 'user.company'],
    });

    if (!inquiry || !inquiry.user) {
      throw new BadRequestException('1:1 문의가 존재하지 않습니다.');
    }

    return {
      id: inquiry.id,
      createdAt: format(inquiry.createdAt, DateFormatStr),
      userBusinessName: inquiry.user.company?.businessName ?? '',
      userPersonName: inquiry.user.personName,
      userEmail: inquiry.user.email,
      userPersonPhoneNumber: inquiry.user.personPhoneNumber,
      status: inquiry.status,
      title: inquiry.title,
      content: inquiry.content,
      filePath: inquiry.filePath ? inquiry.filePath.split(',') : [],
      replyContent: inquiry.replyContent,
    };
  }

  async create(user: ILoginUserInfo, getBody: InquiryCreateReqDto) {
    const { filePathList, title, content } = getBody;

    await this.inquiryRepository.insert({
      userId: user.id,
      filePath: filePathList.length !== 0 ? filePathList.join(',') : null,
      status: InquiryStatus.REGISTER,
      title,
      content,
    });

    return;
  }

  async reply(user: ILoginUserInfo, getBody: InquiryReplyReqDto) {
    const { id, replyContent } = getBody;

    const inquiry = await this.inquiryRepository.findOne({
      where: {
        id: id,
      },
    });

    if (!inquiry) {
      throw new BadRequestException('1:1 문의가 존재하지 않습니다.');
    }

    inquiry.replyContent = replyContent;

    await this.inquiryRepository.save(inquiry);

    return;
  }
}
