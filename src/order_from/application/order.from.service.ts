import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { OrderFromDefinitionEntity } from '../../entity/order.from.definition.entity';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull, Like, Repository } from 'typeorm';
import { OrderFromDefinitionType, OrderFromRequestStatus } from '../interface/order.from.definition.type';
import { OrderFromGetEmailListResDto, OrderFromGetPhoneListResDto, OrderFromPhoneManageListResDto } from '../api/order.from.res.dto';
import {
  OrderFromAdminGetListReqDto,
  OrderFromAdminUpdateCertReqDto,
  OrderFromCreateEmailReqDto,
  OrderFromCreatePhoneReqDto,
  OrderFromGetPhoneReqQueryDto,
  OrderFromSetDefaultReqDto,
} from '../api/order.from.req.dto';
import { IMailSend } from '../../mail/interface/mail-send';
import { ConfigService } from '@nestjs/config';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { IUserAuthority } from '../../user/interface/user.authority';
import { UserEntity } from '../../entity/user.entity';
import { normalizeFromPhone, isBlankAfterNormalize } from '../domain/from-phone.normalize';
import { systemFromPhoneNumber } from '../../const';
import { IOrderSendMethod } from '../../order/interface/order.send.method';

@Injectable()
export class OrderFromService {
  constructor(
    @InjectRepository(OrderFromDefinitionEntity)
    private orderFromDefinitionRepository: Repository<OrderFromDefinitionEntity>,
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
    @Inject('IMailSend')
    private mailSend: IMailSend,
    private configService: ConfigService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  // 본인이거나 대리 권한(SUPER_ADMIN/OPERATION_ADMIN)이면 타 계정 userId 허용.
  // CORPORATE_ADMIN(일반 고객사 계정)은 타 계정 접근 차단 (IDOR 방지).
  // 프론트 대리주문 권한 경계(authority !== CORPORATE_ADMIN)와 일치.
  private assertCanActForUser(user: ILoginUserInfo, targetUserId: number): void {
    if (targetUserId !== user.id && user.authority === IUserAuthority.CORPORATE_ADMIN) {
      throw new ForbiddenException('접근 권한이 없습니다.');
    }
  }

  async getPhoneList(
    user: ILoginUserInfo,
    getQuery: OrderFromGetPhoneReqQueryDto,
  ): Promise<OrderFromGetPhoneListResDto> {
    // 빈 쿼리(`?userId=`)가 0 으로 변환되어 들어오는 경우까지 본인 조회로 폴백.
    // (?? 는 0 을 잡지 못하므로 양수만 타 계정 조회로 취급)
    const targetUserId =
      getQuery.userId && getQuery.userId > 0 ? getQuery.userId : user.id;

    // IDOR 방지: 타 계정 userId는 대리 권한 보유자만 허용
    this.assertCanActForUser(user, targetUserId);

    // 1. 본인 발신번호 조회
    const ownList = await this.orderFromDefinitionRepository.find({
      where: {
        type: OrderFromDefinitionType.PHONE,
        userId: targetUserId,
        requestStatus: OrderFromRequestStatus.APPROVED,
      },
      order: {
        isDefault: 'DESC',
        id: 'ASC',
      },
    });

    if (ownList.length > 0) {
      return { list: this.toPhoneViewList(ownList) };
    }

    // 2. 본인 발신번호가 없으면 같은 회사의 다른 계정 발신번호 조회
    const targetUser = await this.userRepository.findOne({
      where: { id: targetUserId },
      select: ['id', 'companyId'],
    });

    if (!targetUser?.companyId) {
      return { list: [] };
    }

    const companyUsers = await this.userRepository.find({
      where: { companyId: targetUser.companyId },
      select: ['id'],
    });

    if (companyUsers.length === 0) {
      return { list: [] };
    }

    const companyList = await this.orderFromDefinitionRepository.find({
      where: {
        type: OrderFromDefinitionType.PHONE,
        userId: In(companyUsers.map((u) => u.id)),
        requestStatus: OrderFromRequestStatus.APPROVED,
      },
      order: {
        id: 'ASC',
      },
    });

    // 중복 번호 제거, 타 계정 번호이므로 isDefault는 false
    const seen = new Set<string>();
    const phoneList = companyList
      .filter((item) => {
        if (seen.has(item.from)) return false;
        seen.add(item.from);
        return true;
      })
      .map((item) => ({ ...this.toPhoneView(item), isDefault: false }));

    return { list: phoneList };
  }

  async getPhoneManageList(user: ILoginUserInfo): Promise<OrderFromPhoneManageListResDto> {
    const list = await this.orderFromDefinitionRepository.find({
      where: {
        type: OrderFromDefinitionType.PHONE,
        userId: user.id,
        deletedAt: IsNull(),
      },
      order: {
        createdAt: 'DESC',
      },
    });

    return { list: this.toPhoneViewList(list) };
  }

  private toPhoneView(item: OrderFromDefinitionEntity) {
    return {
      id: item.id,
      from: item.from,
      isDefault: item.isDefault,
      requestStatus: item.requestStatus,
      telecomCertType: item.telecomCertType,
      telecomCertFile: item.telecomCertFile,
      rejectReason: item.rejectReason,
      createdAt: item.createdAt,
    };
  }

  private toPhoneViewList(list: OrderFromDefinitionEntity[]) {
    return list.map((item) => this.toPhoneView(item));
  }

  async createPhone(user: ILoginUserInfo, getBody: OrderFromCreatePhoneReqDto) {
    const { from, userId, telecomCertType, telecomCertFile } = getBody;
    const targetUserId = userId ?? user.id;

    // IDOR 방지: 타 계정 명의 등록은 대리 권한 보유자만 허용
    this.assertCanActForUser(user, targetUserId);

    // 블랙리스트 차단: 공용 대표번호 등 등록 불가 (숫자만 추출 후 비교)
    const blacklistedNumbers = ['16443614'];
    if (blacklistedNumbers.includes(from.replace(/\D/g, ''))) {
      throw new BadRequestException('등록할 수 없는 발신 번호입니다.');
    }

    const existFromPhone = await this.orderFromDefinitionRepository.existsBy({
      from,
      type: OrderFromDefinitionType.PHONE,
      userId: targetUserId,
      deletedAt: IsNull(),
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
      telecomCertType: telecomCertType ?? null,
      telecomCertFile: telecomCertFile ?? null,
    });
  }

  async getEmailList(): Promise<OrderFromGetEmailListResDto> {
    const orderFromDefinitionList = await this.orderFromDefinitionRepository.find({
      where: {
        type: OrderFromDefinitionType.EMAIL,
        deletedAt: IsNull(),
        requestStatus: OrderFromRequestStatus.APPROVED,
      },
    });

    return {
      list: orderFromDefinitionList.map((item) => ({ id: item.id, from: item.from })),
    };
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

  async getAdminList(getQuery: OrderFromAdminGetListReqDto) {
    const page = getQuery.page ?? 1;
    const take = getQuery.take ?? 10;
    const skip = (page - 1) * take;

    const whereCondition: Record<string, unknown> = {
      type: In([OrderFromDefinitionType.PHONE]),
      deletedAt: IsNull(),
      requestStatus: In([OrderFromRequestStatus.PENDING, OrderFromRequestStatus.APPROVED]),
    };

    if (getQuery.userId !== undefined) {
      whereCondition.userId = getQuery.userId;
    }

    if (getQuery.search !== undefined && getQuery.search.trim() !== '') {
      whereCondition.from = Like(`%${getQuery.search.trim()}%`);
    }

    const [list, totalCount] = await this.orderFromDefinitionRepository.findAndCount({
      where: whereCondition,
      order: {
        createdAt: 'DESC',
      },
      skip,
      take,
    });

    const totalPage = Math.ceil(totalCount / take);

    // userId 목록 추출 후 user email 조회
    const userIds = [...new Set(list.map((item) => item.userId).filter((id) => id !== null))];
    const users = userIds.length > 0 ? await this.userRepository.find({ where: { id: In(userIds) } }) : [];
    const userEmailMap = new Map(users.map((user) => [user.id, user.email]));

    return {
      list: list.map((item) => ({
        id: item.id,
        type: item.type,
        from: item.from,
        userEmail: item.userId ? userEmailMap.get(item.userId) ?? '' : '',
        requestStatus: item.requestStatus,
        telecomCertType: item.telecomCertType,
        telecomCertFile: item.telecomCertFile,
        rejectReason: item.rejectReason,
        createdAt: item.createdAt,
      })),
      totalCount,
      totalPage,
      currentPage: page,
    };
  }

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

  async adminReject(id: number, rejectReason?: string) {
    const item = await this.orderFromDefinitionRepository.findOne({
      where: {
        id,
        deletedAt: IsNull(),
        requestStatus: OrderFromRequestStatus.PENDING,
      },
    });

    if (!item) {
      throw new BadRequestException('거절할 수 있는 요청이 없습니다.');
    }

    await this.orderFromDefinitionRepository.update(id, {
      requestStatus: OrderFromRequestStatus.REJECTED,
      rejectReason: rejectReason ?? null,
    });
  }

  async adminUpdateCert(body: OrderFromAdminUpdateCertReqDto) {
    const updateData: Partial<Pick<OrderFromDefinitionEntity, 'telecomCertType' | 'telecomCertFile'>> = {};
    if (body.telecomCertType !== undefined) updateData.telecomCertType = body.telecomCertType;
    if (body.telecomCertFile !== undefined) updateData.telecomCertFile = body.telecomCertFile;

    if (Object.keys(updateData).length === 0) return;

    const result = await this.orderFromDefinitionRepository.update(
      { id: body.id, deletedAt: IsNull() },
      updateData,
    );

    if (!result.affected) {
      throw new BadRequestException('존재하지 않는 발신번호입니다.');
    }
  }

  async setDefault(user: ILoginUserInfo, getBody: OrderFromSetDefaultReqDto) {
    const { id, userId } = getBody;
    const targetUserId = userId ?? user.id;

    // IDOR 방지: 타 계정 기본 발신번호 설정은 대리 권한 보유자만 허용
    this.assertCanActForUser(user, targetUserId);

    const item = await this.orderFromDefinitionRepository.findOne({
      where: {
        id,
        type: OrderFromDefinitionType.PHONE,
        userId: targetUserId,
        deletedAt: IsNull(),
        requestStatus: OrderFromRequestStatus.APPROVED,
      },
    });

    if (!item) {
      throw new BadRequestException('존재하지 않는 발신번호입니다.');
    }

    // 해당 사용자의 기존 기본 발신번호 해제
    await this.orderFromDefinitionRepository.update(
      {
        userId: targetUserId,
        type: OrderFromDefinitionType.PHONE,
        isDefault: true,
      },
      { isDefault: false },
    );

    // 새로운 기본 발신번호 설정
    await this.orderFromDefinitionRepository.update(id, { isDefault: true });
  }

  /** 해당 user 의 APPROVED PHONE from 정규화 Set (1회 조회). */
  async getApprovedPhoneSet(userId: number): Promise<Set<string>> {
    const rows = await this.orderFromDefinitionRepository.find({
      where: {
        type: OrderFromDefinitionType.PHONE,
        userId,
        requestStatus: OrderFromRequestStatus.APPROVED,
        deletedAt: IsNull(),
      },
      select: ['from'],
    });
    return new Set(rows.map((r) => normalizeFromPhone(r.from)));
  }

  /** 표시/MMS 용. APPROVED PHONE 기본(isDefault DESC,id ASC) from, 없으면 null. 시스템번호로 대체하지 않는다. */
  async resolveApprovedDefaultPhone(userId: number): Promise<string | null> {
    const rows = await this.orderFromDefinitionRepository.find({
      where: {
        type: OrderFromDefinitionType.PHONE,
        userId,
        requestStatus: OrderFromRequestStatus.APPROVED,
        deletedAt: IsNull(),
      },
      order: { isDefault: 'DESC', id: 'ASC' },
      take: 1,
    });
    return rows.length > 0 ? rows[0].from : null;
  }

  /** 발송 안전망 전용. 승인 기본번호 없으면 systemFromPhoneNumber. 표시에 사용 금지. */
  async resolveSendDefaultPhone(userId: number): Promise<string> {
    return (await this.resolveApprovedDefaultPhone(userId)) ?? systemFromPhoneNumber;
  }

  /**
   * 주문 생성 발신번호 정책 검증.
   * - MMS: billingUserId 의 APPROVED PHONE 에 정규화 매칭 필수.
   * - ALIM_TALK: systemFromPhoneNumber 만 허용.
   * - 그 외(EMAIL 등): skip.
   * APPROVED 목록은 1회 조회 후 Set 재사용.
   */
  async assertApprovedPhones(
    billingUserId: number,
    mappings: Array<{ sendMethod: IOrderSendMethod; fromPhoneNumber: string | null }>,
  ): Promise<void> {
    const needsMms = mappings.some((m) => m.sendMethod === IOrderSendMethod.MMS);
    const approved = needsMms ? await this.getApprovedPhoneSet(billingUserId) : new Set<string>();
    const systemNorm = normalizeFromPhone(systemFromPhoneNumber);

    for (const m of mappings) {
      if (m.sendMethod === IOrderSendMethod.MMS) {
        if (isBlankAfterNormalize(m.fromPhoneNumber)) {
          throw new BadRequestException('발신 번호를 입력해 주세요.');
        }
        if (!approved.has(normalizeFromPhone(m.fromPhoneNumber))) {
          throw new BadRequestException('승인된 발신번호가 아닙니다.');
        }
      } else if (m.sendMethod === IOrderSendMethod.ALIM_TALK) {
        if (normalizeFromPhone(m.fromPhoneNumber) !== systemNorm) {
          throw new BadRequestException('알림톡 발신번호가 올바르지 않습니다.');
        }
      }
    }
  }
}
