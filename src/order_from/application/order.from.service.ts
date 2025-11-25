import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { OrderFromDefinitionEntity } from '../../entity/order.from.definition.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import { OrderFromDefinitionType, OrderFromRequestStatus } from '../interface/order.from.definition.type';
import { OrderFromGetPhoneListResDto } from '../api/order.from.res.dto';
import {
  OrderFromCreateEmailReqDto,
  OrderFromCreatePhoneReqDto,
  OrderFromGetPhoneReqQueryDto,
} from '../api/order.from.req.dto';
import { IMailSend } from '../../mail/interface/mail-send';
import { ConfigService } from '@nestjs/config';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { IUserAuthority } from '../../user/interface/user.authority';

@Injectable()
export class OrderFromService {
  constructor(
    @InjectRepository(OrderFromDefinitionEntity)
    private orderFromDefinitionRepository: Repository<OrderFromDefinitionEntity>,
    @Inject('IMailSend')
    private mailSend: IMailSend,
    private configService: ConfigService,
  ) {}

  async getPhoneList(
    user: ILoginUserInfo,
    getQuery: OrderFromGetPhoneReqQueryDto,
  ): Promise<OrderFromGetPhoneListResDto> {
    const orderFromDefinitionList = await this.orderFromDefinitionRepository.find({
      where: {
        type: OrderFromDefinitionType.PHONE,
        userId: getQuery.userId ? getQuery.userId : user.id,
        requestStatus: OrderFromRequestStatus.APPROVED,
      },
    });

    const phoneList = orderFromDefinitionList.map((orderFromDefinition) => {
      return {
        id: orderFromDefinition.id,
        from: orderFromDefinition.from,
      };
    });

    return { list: phoneList };
  }

  async createPhone(user: ILoginUserInfo, getBody: OrderFromCreatePhoneReqDto) {
    const { from, userId } = getBody;
    const targetUserId = userId ? userId : user.id;

    const existFromPhone = await this.orderFromDefinitionRepository.existsBy({
      from,
      type: OrderFromDefinitionType.PHONE,
      userId: targetUserId,
    });

    if (existFromPhone) {
      throw new BadRequestException('이미 존재하는 발신 번호 입니다.');
    }

    // 로그인 사용자 권한 기준: SUPER_ADMIN은 바로 승인, 나머지는 요청 상태로 저장
    const requestStatus =
      user.authority === IUserAuthority.SUPER_ADMIN
        ? OrderFromRequestStatus.APPROVED
        : OrderFromRequestStatus.PENDING;

    await this.orderFromDefinitionRepository.insert({
      from,
      type: OrderFromDefinitionType.PHONE,
      userId: targetUserId,
      requestStatus,
    });
  }

  async getEmailList(): Promise<OrderFromGetPhoneListResDto> {
    const orderFromDefinitionList = await this.orderFromDefinitionRepository.find({
      where: {
        type: OrderFromDefinitionType.EMAIL,
        deletedAt: IsNull(),
        requestStatus: OrderFromRequestStatus.APPROVED,
      },
    });

    const emailList = orderFromDefinitionList.map((orderFromDefinition) => {
      return {
        id: orderFromDefinition.id,
        from: orderFromDefinition.from,
      };
    });

    return { list: emailList };
  }

  async createEmail(getBody: OrderFromCreateEmailReqDto) {
    const { from } = getBody;

    const existFromEmail = await this.orderFromDefinitionRepository.existsBy({
      from,
      type: OrderFromDefinitionType.EMAIL,
    });

    if (existFromEmail) {
      throw new BadRequestException('이미 존재하는 이메일 입니다.');
    }

    const hiWorksId = this.configService.getOrThrow('MAIL_HIGH_WORKS_ID');

    const result = await this.mailSend.send({
      saveSentMail: 'N',
      bcc: undefined,
      cc: undefined,
      content: '발신 등록 용 이메일 입니다.',
      subject: '발신 등록 용 이메일 입니다.',
      to: `${hiWorksId}@enmad.com`,
      fromEmail: from,
    });

    if (result.code !== 'SUC') {
      throw new BadRequestException('등록할 수 없는 발신 이메일입니다.');
    }

    await this.orderFromDefinitionRepository.insert({
      from,
      type: OrderFromDefinitionType.EMAIL,
    });
  }

  async deleteEmail(id: number) {
    const email = await this.orderFromDefinitionRepository.findOne({
      where: {
        id,
        type: OrderFromDefinitionType.EMAIL,
        deletedAt: IsNull(),
      },
    });

    if (!email) {
      throw new BadRequestException('존재하지 않는 이메일입니다.');
    }

    await this.orderFromDefinitionRepository.softDelete(id);
  }

  // ==================== 관리자용 메소드 ====================

  /**
   * 관리자용 전체 조회 (삭제/거절 제외)
   */
  async getAdminList() {
    const list = await this.orderFromDefinitionRepository.find({
      where: {
        deletedAt: IsNull(),
        requestStatus: In([OrderFromRequestStatus.PENDING, OrderFromRequestStatus.APPROVED]),
      },
      order: {
        createdAt: 'DESC',
      },
    });

    return {
      list: list.map((item) => ({
        id: item.id,
        type: item.type,
        from: item.from,
        userId: item.userId,
        requestStatus: item.requestStatus,
        createdAt: item.createdAt,
      })),
    };
  }

  /**
   * 관리자용 삭제 (soft delete)
   */
  async adminDelete(id: number) {
    const item = await this.orderFromDefinitionRepository.findOne({
      where: {
        id,
        deletedAt: IsNull(),
      },
    });

    if (!item) {
      throw new BadRequestException('존재하지 않는 발신번호/이메일입니다.');
    }

    await this.orderFromDefinitionRepository.softDelete(id);
  }

  /**
   * 관리자용 승인 (PENDING → APPROVED)
   */
  async adminApprove(id: number) {
    const item = await this.orderFromDefinitionRepository.findOne({
      where: {
        id,
        deletedAt: IsNull(),
        requestStatus: OrderFromRequestStatus.PENDING,
      },
    });

    if (!item) {
      throw new BadRequestException('승인할 수 있는 요청이 없습니다.');
    }

    await this.orderFromDefinitionRepository.update(id, {
      requestStatus: OrderFromRequestStatus.APPROVED,
    });
  }
}
