import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { UserEntity } from '../../entity/user.entity';
import { In, Repository } from 'typeorm';
import {
  UserTaskHistoryCreateReqDto,
  UserTaskHistoryDeleteReqDto,
  UserTaskHistoryGetDetailReqParamDto,
  UserTaskHistoryGetListReqQueryDto,
} from '../api/user.task.history.req.dto';
import { UserTaskHistoryGetDetailResDto, UserTaskHistoryGetListResDto } from '../api/user.task.history.res.dto';
import { UserTaskHistoryViewDto } from '../api/dto/user.task.history.view.dto';
import { format } from 'date-fns';
import { DateDateFormatStr, DateFormatStr } from '../../common/domain/date.format.str';
import { OrderEntity } from '../../entity/order.entity';
import { IOrderStatus } from '../../order/interface/order.status';
import { UserTaskHistoryEntity } from '../../entity/user.task.history.entity';
import { UserTaskHistoryDetailViewDto } from '../api/dto/user.task.history.detail.view.dto';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { QueryBuilderDateCondition } from '../../common/infra/query.builder.date.condition';

@Injectable()
export class UserTaskHistoryService {
  constructor(
    @InjectRepository(UserTaskHistoryEntity)
    private readonly userTaskHistoryRepository: Repository<UserTaskHistoryEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    @InjectRepository(OrderEntity)
    private readonly orderRepository: Repository<OrderEntity>,
  ) {}

  async getList(getQuery: UserTaskHistoryGetListReqQueryDto): Promise<UserTaskHistoryGetListResDto> {
    const {
      createdStartAt,
      createdEndAt,
      email,
      businessName,
      personName,
      personPhoneNumber,
      personCategory,
      page,
      take,
    } = getQuery;

    let queryBuilder = this.userRepository.createQueryBuilder('user');

    queryBuilder = QueryBuilderDateCondition(queryBuilder, 'user', 'createdAt', createdStartAt, createdEndAt);

    if (email) {
      queryBuilder = queryBuilder.andWhere('user.email LIKE :email', { email: `${email}%` });
    }

    if (businessName) {
      queryBuilder = queryBuilder.andWhere('user.businessName LIKE :businessName', {
        businessName: `%${businessName}%`,
      });
    }

    if (personName) {
      queryBuilder = queryBuilder.andWhere('user.personName LIKE :personName', {
        personName: `%${personName}%`,
      });
    }

    if (personPhoneNumber) {
      queryBuilder = queryBuilder.andWhere('user.personPhoneNumber LIKE :personPhoneNumber', {
        personPhoneNumber: `%${personPhoneNumber}%`,
      });
    }

    if (personCategory) {
      queryBuilder = queryBuilder.andWhere('user.personCategory LIKE :personCategory', {
        personCategory: `%${personCategory}%`,
      });
    }

    queryBuilder = queryBuilder.orderBy('user.id', 'DESC');

    const skip = (page - 1) * take;
    queryBuilder = queryBuilder.take(take).skip(skip);

    const [userList, totalCount] = await queryBuilder.getManyAndCount();

    // 거래금액, 거래회수, 최초거래일, 최종거래일
    const userIdList = userList.map((user) => user.id);
    const orderList = await this.orderRepository.find({
      where: {
        userId: In(userIdList),
        status: In([IOrderStatus.DELIVERY_REQUEST, IOrderStatus.DELIVERY_CONFIRMED, IOrderStatus.DELIVERY_COMPLETE]),
      },
    });

    const orderMapByUserId = orderList.reduce<Record<number, OrderEntity[]>>((map, order) => {
      if (!map[order.userId]) map[order.userId] = [];
      map[order.userId].push(order);
      return map;
    }, {});

    const resultList: UserTaskHistoryViewDto[] = userList.map((user) => {
      // 거래금액, 거래회수, 최초거래일, 최종거래일
      const userOrderList = orderMapByUserId[user.id] || [];
      const transactionCount = userOrderList.length;
      const transactionAmount = userOrderList.reduce((totalAmount, order) => totalAmount + order.sendAmount, 0);
      const firstTransactionDate = transactionCount
        ? format(new Date(Math.min(...userOrderList.map((order) => order.registerAt.getTime()))), DateDateFormatStr)
        : null;
      const lastTransactionDate = transactionCount
        ? format(new Date(Math.max(...userOrderList.map((order) => order.registerAt.getTime()))), DateDateFormatStr)
        : null;

      return {
        id: user.id,
        registerDate: format(user.createdAt, DateDateFormatStr),
        email: user.email,
        personCode: user.personCode,
        businessName: user.businessName,
        personName: user.personName,
        personPhoneNumber: user.personPhoneNumber,
        transactionAmount: transactionAmount,
        transactionCount: transactionCount,
        businessGrade: user.businessGrade,
        personCategory: user.personCategory,
        firstTransactionDate: firstTransactionDate,
        lastTransactionDate: lastTransactionDate,
      };
    });

    const totalPage = Math.ceil(totalCount / take);

    return { list: resultList, totalCount, totalPage, currentPage: page };
  }

  async getDetail(getParam: UserTaskHistoryGetDetailReqParamDto): Promise<UserTaskHistoryGetDetailResDto> {
    const { id } = getParam;

    const user = await this.userRepository.findOne({
      where: {
        id,
      },
    });

    if (!user) {
      throw new BadRequestException('유저가 존재하지 않습니다.');
    }

    const taskHistoryList = await this.userTaskHistoryRepository.find({
      where: { userId: user.id },
    });

    const adminUserIdList = taskHistoryList.map((task) => task.adminUserId);

    const adminUsers = await this.userRepository.find({
      where: {
        id: In(adminUserIdList),
      },
    });
    const adminUserMap = new Map(adminUsers.map((user) => [user.id, user.personName]));

    const resultList = taskHistoryList.map((task): UserTaskHistoryDetailViewDto => {
      return {
        id: task.id,
        adminUserName: adminUserMap.get(task.adminUserId) || null,
        registerAt: format(task.createdAt, DateFormatStr),
        content: task.content,
      };
    });

    return {
      id: user.id,
      email: user.email,
      personName: user.personName,
      personPhoneNumber: user.personPhoneNumber,
      personEmail: user.personEmail,
      personCode: user.personCode,
      personCategory: user.personCategory,
      businessGrade: user.businessGrade,
      list: resultList,
    };
  }

  async create(user: ILoginUserInfo, getBody: UserTaskHistoryCreateReqDto) {
    const { userId, content } = getBody;

    await this.userTaskHistoryRepository.insert({
      userId: userId,
      adminUserId: user.id,
      content: content,
    });

    return true;
  }

  async delete(deleteBody: UserTaskHistoryDeleteReqDto) {
    const { id } = deleteBody;

    const taskHistory = await this.userTaskHistoryRepository.findOne({
      where: {
        id,
      },
    });

    if (!taskHistory) {
      throw new BadRequestException('해당 상담내역을 찾을 수 없거나 이미 삭제되었습니다.');
    }

    await this.userTaskHistoryRepository.softDelete({ id: taskHistory.id });

    return true;
  }
}
