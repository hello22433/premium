import { BadRequestException, Injectable } from '@nestjs/common';
import { NoticeEntity } from '../../entity/notice.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  NoticeCreateReqDto,
  NoticeGetDetailReqParamDto,
  NoticeGetListReqQueryDto,
  NoticeUpdateReqDto,
} from '../api/notice.req.dto';
import { NoticeViewDto } from '../api/dto/notice.view.dto';
import { NoticeGetDetailResDto, NoticeGetListResDto } from '../api/notice.res.dto';
import { DateFormatStr } from '../../common/domain/date.format.str';
import { format } from 'date-fns';
import { ILoginUserInfo } from '../../auth/interface/login.user';

@Injectable()
export class NoticeService {
  constructor(
    @InjectRepository(NoticeEntity)
    private noticeRepository: Repository<NoticeEntity>,
  ) {}

  async getList(getQuery: NoticeGetListReqQueryDto): Promise<NoticeGetListResDto> {
    const { take, page } = getQuery;

    let queryBuilder = this.noticeRepository.createQueryBuilder('notice').innerJoinAndSelect('notice.user', 'user');

    const skip = (page - 1) * take;
    queryBuilder = queryBuilder.skip(skip).take(take);
    queryBuilder.orderBy('notice.id', 'DESC');
    const [noticeList, totalCount] = await queryBuilder.getManyAndCount();

    const totalPage = Math.ceil(totalCount / take);

    const resultList: NoticeViewDto[] = noticeList.map((notice) => {
      const isFile = !!notice.filePath;
      const fileCount = isFile ? notice.filePath!.split(',').length : 0;
      return {
        id: notice.id,
        userId: notice.userId,
        userName: notice.user.personName,
        priority: notice.priority,
        title: notice.title,
        isFile: isFile,
        fileCount: fileCount,
        registerAt: format(notice.registerAt, DateFormatStr),
      };
    });

    return { list: resultList, totalCount, totalPage, currentPage: page };
  }

  async getDetail(getParam: NoticeGetDetailReqParamDto): Promise<NoticeGetDetailResDto> {
    const { id } = getParam;

    const notice = await this.noticeRepository.findOne({
      where: {
        id,
      },
    });

    if (!notice) {
      throw new BadRequestException('공지사항이 존재하지 않습니다.');
    }

    return {
      id: notice.id,
      title: notice.title,
      content: notice.content,
      priority: notice.priority,
      registerAt: format(notice.registerAt, DateFormatStr),
      filePathList: notice.filePath ? notice.filePath.split(',') : [],
    };
  }

  async create(user: ILoginUserInfo, getBody: NoticeCreateReqDto) {
    const { title, content, priority, filePath } = getBody;

    await this.noticeRepository.insert({
      userId: user.id,
      title,
      content,
      priority,
      registerAt: new Date(),
      filePath: filePath.length === 0 ? null : filePath.join(','),
    });

    return;
  }

  async update(user: ILoginUserInfo, getBody: NoticeUpdateReqDto) {
    const { id, title, content, priority, filePath } = getBody;

    const notice = await this.noticeRepository.findOne({
      where: {
        id,
        userId: user.id,
      },
    });

    if (!notice) {
      throw new BadRequestException('공지사항이 존재하지 않습니다.');
    }

    notice.title = title;
    notice.content = content;
    notice.priority = priority;
    notice.filePath = filePath.length === 0 ? null : filePath.join(',');
    await this.noticeRepository.save(notice);

    return;
  }
}
