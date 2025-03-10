import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { SsgEventEntity } from '../../entity/ssg.event.entity';
import { Repository } from 'typeorm';
import { SsgEventCreateReqDto, SsgEventGetListReqDto, SsgEventUpdateAmountReqDto } from '../api/ssg.event.req.dto';
import { SsgEventGetListResDto } from '../api/ssg.event.res.dto';
import { SsgEventViewDto } from '../api/dto/ssg.event.view.dto';
import { DateFormatStr } from '../../common/domain/date.format.str';
import { format } from 'date-fns';
import { SsgEventAmountHistoryEntity } from '../../entity/ssg.event.amount.history.entity';

@Injectable()
export class SsgEventService {
  constructor(
    @InjectRepository(SsgEventEntity)
    private readonly ssgEventRepository: Repository<SsgEventEntity>,
    @InjectRepository(SsgEventAmountHistoryEntity)
    private readonly amountHistoryRepository: Repository<SsgEventAmountHistoryEntity>,
  ) {}

  async getList(getQuery: SsgEventGetListReqDto): Promise<SsgEventGetListResDto> {
    const { take, page, code, createdEndAt, createdStartAt, name } = getQuery;
    const skip = (page - 1) * take;

    let queryBuilder = this.ssgEventRepository.createQueryBuilder('ssg');

    if (code) {
      queryBuilder = queryBuilder.andWhere('ssg.code LIKE :code', { code: '%' + code + '%' });
    }

    if (name) {
      queryBuilder = queryBuilder.andWhere('ssg.name LIKE :name', { name: '%' + name + '%' });
    }

    if (createdStartAt && !createdEndAt) {
      queryBuilder = queryBuilder.andWhere('ssg.createdAt >= :createdStartAt', {
        createdStartAt: new Date(createdStartAt),
      });
    }

    if (!createdStartAt && createdEndAt) {
      queryBuilder = queryBuilder.andWhere('ssg.createdAt <= :createdEndAt', {
        createdEndAt: new Date(createdEndAt),
      });
    }

    if (createdStartAt && createdEndAt) {
      queryBuilder = queryBuilder.andWhere('ssg.createdAt BETWEEN :createdStartAt AND :createdEndAt', {
        createdStartAt: new Date(createdStartAt),
        createdEndAt: new Date(createdEndAt),
      });
    }

    const [eventList, totalCount] = await queryBuilder.skip(skip).take(take).getManyAndCount();

    const totalPage = Math.ceil(totalCount / take);

    const resultList: SsgEventViewDto[] = eventList.map((event) => {
      return {
        id: event.id,
        code: event.code,
        name: event.name,
        startAt: format(event.startAt, DateFormatStr),
        endAt: format(event.endAt, DateFormatStr),
        eventPrice: event.eventPrice,
        eventBalance: 15000,
      };
    });

    return { list: resultList, totalCount, totalPage, currentPage: page };
  }

  async create(getBody: SsgEventCreateReqDto) {
    const { code, name, startAt, endAt, couponExpiration, eventPrice } = getBody;

    await this.ssgEventRepository.insert({
      code,
      name,
      startAt: new Date(startAt),
      endAt: new Date(endAt),
      couponExpiration,
      eventPrice,
    });
    return;
  }

  async updateAmount(getBody: SsgEventUpdateAmountReqDto) {
    const { id, amount } = getBody;

    const ssgEvent = await this.ssgEventRepository.findOne({
      where: {
        id,
      },
    });

    if (!ssgEvent) {
      throw new BadRequestException('존재하지 않는 이벤트입니다.');
    }

    const lastHistory = await this.amountHistoryRepository.findOne({
      where: {
        ssgEventId: id,
      },
      order: {
        createdAt: 'DESC',
      },
    });

    const lastBalance = lastHistory ? lastHistory.balance : 0;
    const newBalance = lastBalance + amount;

    const ssgEventAmountHistory = this.amountHistoryRepository.create({
      ssgEventId: ssgEvent.id,
      amount: amount,
      balance: newBalance,
    });
    await this.amountHistoryRepository.save(ssgEventAmountHistory);
  }
}
