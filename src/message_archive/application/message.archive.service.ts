import { Injectable } from '@nestjs/common';
import { MessageArchiveEntity } from '../../entity/message.archive.entity';
import { FindOptionsWhere, Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { MessageArchiveGetListResDto } from '../api/message.archive.res.dto';
import { MessageArchiveCreateReqDto, MessageArchiveGetListReqQueryDto } from '../api/message.archive.req.dto';
import { MessageArchiveViewDto } from '../api/dto/message.archive.view.dto';

@Injectable()
export class MessageArchiveService {
  constructor(
    @InjectRepository(MessageArchiveEntity)
    private messageArchiveRepository: Repository<MessageArchiveEntity>,
  ) {}

  async getList(
    user: ILoginUserInfo,
    getQuery: MessageArchiveGetListReqQueryDto,
  ): Promise<MessageArchiveGetListResDto> {
    const { take, page } = getQuery;

    const whereCondition: FindOptionsWhere<MessageArchiveEntity> = {
      userId: user.id,
    };
    const skip = (page - 1) * take;
    const messageArchiveList = await this.messageArchiveRepository.find({
      where: whereCondition,
      take,
      skip,
    });

    const totalCount = await this.messageArchiveRepository.count({
      where: whereCondition,
    });

    const totalPage = Math.ceil(totalCount / take);

    const resultList: MessageArchiveViewDto[] = messageArchiveList.map((messageArchive) => {
      return {
        id: messageArchive.id,
        title: messageArchive.title,
        content: messageArchive.content,
      };
    });

    return { list: resultList, totalCount, totalPage, currentPage: page };
  }

  async create(user: ILoginUserInfo, getBody: MessageArchiveCreateReqDto) {
    const { title, content } = getBody;

    await this.messageArchiveRepository.insert({
      userId: user.id,
      title: title,
      content: content,
    });
    return;
  }
}
