import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { parseFilePathList } from '../../util/file.util';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OrderReceiptEntity } from '../../entity/order.receipt.entity';
import {
  OrderReceiptCreateReqDto,
  OrderReceiptGetDetailReqParamDto,
  OrderReceiptGetListReqQueryDto,
  OrderReceiptRejectReqDto,
} from '../api/order.receipt.req.dto';
import { OrderReceiptGetDetailResDto, OrderReceiptGetListResDto } from '../api/order.receipt.res.dto';
import { OrderReceiptViewDto } from '../api/dto/order.receipt.view.dto';
import { OrderReceiptStatus } from '../interface/order.receipt.status';
import { DateFormatStr } from '../../common/domain/date.format.str';
import { format, subDays } from 'date-fns';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { IUserAuthority } from '../../user/interface/user.authority';

@Injectable()
export class OrderReceiptService {
  constructor(
    @InjectRepository(OrderReceiptEntity)
    private orderReceiptRepository: Repository<OrderReceiptEntity>,
  ) {}

  async getList(user: ILoginUserInfo, getQuery: OrderReceiptGetListReqQueryDto): Promise<OrderReceiptGetListResDto> {
    const { take, page, status } = getQuery;

    const queryBuilder = this.orderReceiptRepository
      .createQueryBuilder('orderReceipt')
      .innerJoinAndSelect('orderReceipt.user', 'user');

    // 고객사(CORPORATE_ADMIN)는 본인 건만 + 180일 이내
    if (user.authority === IUserAuthority.CORPORATE_ADMIN) {
      const dateLimit = subDays(new Date(), 180);
      queryBuilder
        .andWhere('orderReceipt.userId = :userId', { userId: user.id })
        .andWhere('orderReceipt.registerAt >= :dateLimit', { dateLimit });
    }

    // 상태 필터
    if (status) {
      queryBuilder.andWhere('orderReceipt.status = :status', { status });
    }

    const skip = (page - 1) * take;
    queryBuilder.skip(skip).take(take).orderBy('orderReceipt.id', 'DESC');
    const [receiptList, totalCount] = await queryBuilder.getManyAndCount();

    const totalPage = Math.ceil(totalCount / take);

    const resultList: OrderReceiptViewDto[] = receiptList.map((receipt) => {
      const isFile = !!receipt.filePath;
      const fileCount = isFile ? receipt.filePath!.split(',').length : 0;
      return {
        id: receipt.id,
        userId: receipt.userId,
        userName: receipt.user.personName,
        title: receipt.title,
        status: receipt.status,
        isFile,
        fileCount,
        registerAt: format(receipt.registerAt, DateFormatStr),
        processedAt: receipt.processedAt ? format(receipt.processedAt, DateFormatStr) : null,
      };
    });

    return { list: resultList, totalCount, totalPage, currentPage: page };
  }

  async getDetail(getParam: OrderReceiptGetDetailReqParamDto): Promise<OrderReceiptGetDetailResDto> {
    const { id } = getParam;

    const receipt = await this.orderReceiptRepository.findOne({
      where: { id },
      relations: ['user', 'processedUser'],
    });

    if (!receipt) {
      throw new BadRequestException('주문접수 건이 존재하지 않습니다.');
    }

    return {
      id: receipt.id,
      userId: receipt.userId,
      userName: receipt.user.personName,
      title: receipt.title,
      status: receipt.status,
      filePathList: parseFilePathList(receipt.filePath),
      rejectReason: receipt.rejectReason,
      registerAt: format(receipt.registerAt, DateFormatStr),
      processedAt: receipt.processedAt ? format(receipt.processedAt, DateFormatStr) : null,
      processedUserName: receipt.processedUser?.personName ?? null,
    };
  }

  async create(user: ILoginUserInfo, getBody: OrderReceiptCreateReqDto) {
    const { title, filePath } = getBody;

    if (filePath.length === 0) {
      throw new BadRequestException('첨부파일을 등록해주세요.');
    }

    await this.orderReceiptRepository.insert({
      userId: user.id,
      title,
      status: OrderReceiptStatus.RECEIVED,
      filePath: filePath.join(','),
      registerAt: new Date(),
    });
  }

  async approve(user: ILoginUserInfo, id: number) {
    const receipt = await this.findReceiptOrThrow(id);

    if (receipt.status !== OrderReceiptStatus.RECEIVED) {
      throw new BadRequestException('접수 상태인 건만 승인할 수 있습니다.');
    }

    receipt.status = OrderReceiptStatus.APPROVED;
    receipt.processedAt = new Date();
    receipt.processedUserId = user.id;
    await this.orderReceiptRepository.save(receipt);
  }

  async reject(user: ILoginUserInfo, id: number, getBody: OrderReceiptRejectReqDto) {
    const receipt = await this.findReceiptOrThrow(id);

    if (receipt.status !== OrderReceiptStatus.RECEIVED) {
      throw new BadRequestException('접수 상태인 건만 반려할 수 있습니다.');
    }

    receipt.status = OrderReceiptStatus.REJECTED;
    receipt.rejectReason = getBody.rejectReason;
    receipt.processedAt = new Date();
    receipt.processedUserId = user.id;
    await this.orderReceiptRepository.save(receipt);
  }

  async delete(user: ILoginUserInfo, id: number) {
    const receipt = await this.findReceiptOrThrow(id);

    // 본인 건만 삭제 가능, SUPER_ADMIN은 모두 삭제 가능
    const isSuperAdmin = user.authority === IUserAuthority.SUPER_ADMIN;
    const isOwner = receipt.userId === user.id;

    if (!isSuperAdmin && !isOwner) {
      throw new ForbiddenException('삭제 권한이 없습니다.');
    }

    // 승인된 건은 삭제 불가
    if (receipt.status === OrderReceiptStatus.APPROVED) {
      throw new BadRequestException('승인된 건은 삭제할 수 없습니다.');
    }

    await this.orderReceiptRepository.softDelete(id);
  }

  private async findReceiptOrThrow(id: number): Promise<OrderReceiptEntity> {
    const receipt = await this.orderReceiptRepository.findOne({ where: { id } });

    if (!receipt) {
      throw new BadRequestException('주문접수 건이 존재하지 않습니다.');
    }

    return receipt;
  }
}
