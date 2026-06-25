import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { OrderFromDefinitionEntity } from '../../entity/order.from.definition.entity';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull, Like, Repository } from 'typeorm';
import {
  OrderFromDefinitionType,
  OrderFromRequestStatus,
  TelecomCertType,
} from '../interface/order.from.definition.type';
import {
  OrderFromGetEmailListResDto,
  OrderFromGetPhoneListResDto,
  OrderFromPhoneManageListResDto,
} from '../api/order.from.res.dto';
import {
  OrderFromAdminGetListReqDto,
  OrderFromAdminUpdateCertReqDto,
  OrderFromCreateEmailReqDto,
  OrderFromCreatePhoneReqDto,
  OrderFromGetPhoneReqQueryDto,
  OrderFromSetDefaultReqDto,
  OrderFromSetHideSystemReqDto,
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
    const targetUserId = getQuery.userId && getQuery.userId > 0 ? getQuery.userId : user.id;

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

    // SoT user 단위 확정: 본인 APPROVED 번호만 반환 (회사 fallback 제거).
    const hideSystemFromPhone = await this.getHideSystemFromPhone(targetUserId);
    return { list: this.toPhoneViewList(ownList), hideSystemFromPhone };
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

    const hideSystemFromPhone = await this.getHideSystemFromPhone(user.id);
    return { list: this.toPhoneViewList(list), hideSystemFromPhone };
  }

  /** 해당 user 의 시스템 기본번호 숨김 플래그. user 없으면 false. */
  private async getHideSystemFromPhone(userId: number): Promise<boolean> {
    const target = await this.userRepository.findOne({
      where: { id: userId },
      select: ['hideSystemFromPhone'],
    });
    return target?.hideSystemFromPhone ?? false;
  }

  /** MMS 발신번호 선택목록의 시스템 기본번호 숨김 여부 토글 (표시 전용, 발송 동작 불변). */
  async setHideSystemFromPhone(user: ILoginUserInfo, getBody: OrderFromSetHideSystemReqDto): Promise<void> {
    const targetUserId = getBody.userId ?? user.id;
    this.assertCanActForUser(user, targetUserId);

    const result = await this.userRepository.update(targetUserId, {
      hideSystemFromPhone: getBody.hide,
    });
    if (!result.affected) {
      throw new BadRequestException('존재하지 않는 사용자입니다.');
    }
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

    this.assertCanActForUser(user, targetUserId);

    const normFrom = normalizeFromPhone(from);
    if (isBlankAfterNormalize(from)) {
      throw new BadRequestException('발신 번호를 입력해 주세요.');
    }

    // 블랙리스트: 공용 대표번호(시스템번호) 등록 불가
    if (normFrom === normalizeFromPhone(systemFromPhoneNumber)) {
      throw new BadRequestException('등록할 수 없는 발신 번호입니다.');
    }

    // 활성 중복 검사 (정규화 비교)
    const existing = await this.orderFromDefinitionRepository.find({
      where: { type: OrderFromDefinitionType.PHONE, userId: targetUserId, deletedAt: IsNull() },
      select: ['from'],
    });
    if (existing.some((e) => normalizeFromPhone(e.from) === normFrom)) {
      throw new BadRequestException('이미 존재하는 발신 번호 입니다.');
    }

    const requestStatus =
      user.authority === IUserAuthority.SUPER_ADMIN ? OrderFromRequestStatus.APPROVED : OrderFromRequestStatus.PENDING;

    await this.dataSource.transaction(async (manager) => {
      const inserted = await manager.getRepository(OrderFromDefinitionEntity).insert({
        from: normFrom,
        type: OrderFromDefinitionType.PHONE,
        userId: targetUserId,
        requestStatus,
        isDefault: false,
        telecomCertType: telecomCertType ?? null,
        telecomCertFile: telecomCertFile ?? null,
      });
      // SUPER_ADMIN 즉시 승인 시 첫 APPROVED 면 default 0개가 되어 불변식 위반 → reconcile 로 보정.
      if (requestStatus === OrderFromRequestStatus.APPROVED) {
        const newId = inserted.identifiers[0].id as number;
        await this.reconcileDefaultAndMirror(manager, targetUserId, newId);
      }
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
        userEmail: item.userId ? (userEmailMap.get(item.userId) ?? '') : '',
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
    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(OrderFromDefinitionEntity);
      const item = await repo.findOne({ where: { id, deletedAt: IsNull() } });
      if (!item) {
        throw new BadRequestException('존재하지 않는 발신번호/이메일입니다.');
      }
      await repo.softDelete(id);
      if (item.type === OrderFromDefinitionType.PHONE && item.userId) {
        await this.reconcileDefaultAndMirror(manager, item.userId);
      }
    });
  }

  async adminApprove(id: number) {
    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(OrderFromDefinitionEntity);
      const item = await repo.findOne({
        where: { id, deletedAt: IsNull(), requestStatus: OrderFromRequestStatus.PENDING },
      });
      if (!item) {
        throw new BadRequestException('승인할 수 있는 요청이 없습니다.');
      }
      await repo.update(id, { requestStatus: OrderFromRequestStatus.APPROVED });
      if (item.type === OrderFromDefinitionType.PHONE && item.userId) {
        await this.reconcileDefaultAndMirror(manager, item.userId);
      }
    });
  }

  async adminReject(id: number, rejectReason?: string) {
    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(OrderFromDefinitionEntity);
      const item = await repo.findOne({
        where: { id, deletedAt: IsNull(), requestStatus: OrderFromRequestStatus.PENDING },
      });
      if (!item) {
        throw new BadRequestException('거절할 수 있는 요청이 없습니다.');
      }
      await repo.update(id, { requestStatus: OrderFromRequestStatus.REJECTED, rejectReason: rejectReason ?? null });
      if (item.type === OrderFromDefinitionType.PHONE && item.userId) {
        await this.reconcileDefaultAndMirror(manager, item.userId);
      }
    });
  }

  async adminUpdateCert(body: OrderFromAdminUpdateCertReqDto) {
    const updateData: Partial<Pick<OrderFromDefinitionEntity, 'telecomCertType' | 'telecomCertFile'>> = {};
    if (body.telecomCertType !== undefined) updateData.telecomCertType = body.telecomCertType;
    if (body.telecomCertFile !== undefined) updateData.telecomCertFile = body.telecomCertFile;

    if (Object.keys(updateData).length === 0) return;

    const result = await this.orderFromDefinitionRepository.update({ id: body.id, deletedAt: IsNull() }, updateData);

    if (!result.affected) {
      throw new BadRequestException('존재하지 않는 발신번호입니다.');
    }
  }

  /**
   * 단일 트랜잭션에서 user 의 기본 PHONE 을 재정렬하고 user.from_phone_number mirror 를 갱신한다.
   * 불변식: APPROVED PHONE 있으면 활성 기본 정확히 1개, 없으면 0개 + mirror NULL.
   * @param preferDefaultId 우선 기본으로 삼을 행 id. 없으면 자동 선정(기존 default → id ASC).
   */
  private async reconcileDefaultAndMirror(
    manager: EntityManager,
    userId: number,
    preferDefaultId?: number,
  ): Promise<void> {
    const repo = manager.getRepository(OrderFromDefinitionEntity);

    // user row 잠금 (동시성 직렬화)
    await manager
      .getRepository(UserEntity)
      .createQueryBuilder('u')
      .setLock('pessimistic_write')
      .where('u.id = :userId', { userId })
      .getOne();

    const approved = await repo.find({
      where: {
        type: OrderFromDefinitionType.PHONE,
        userId,
        requestStatus: OrderFromRequestStatus.APPROVED,
        deletedAt: IsNull(),
      },
      order: { isDefault: 'DESC', id: 'ASC' },
    });

    // 전체 기본 해제
    await repo.update({ userId, type: OrderFromDefinitionType.PHONE, isDefault: true }, { isDefault: false });

    if (approved.length === 0) {
      await manager.getRepository(UserEntity).update(userId, { fromPhoneNumber: null });
      return;
    }

    const chosen = approved.find((r) => r.id === preferDefaultId) ?? approved.find((r) => r.isDefault) ?? approved[0];

    await repo.update(chosen.id, { isDefault: true });
    await manager.getRepository(UserEntity).update(userId, { fromPhoneNumber: chosen.from });
  }

  async setDefault(user: ILoginUserInfo, getBody: OrderFromSetDefaultReqDto) {
    const { id, userId } = getBody;
    const targetUserId = userId ?? user.id;

    this.assertCanActForUser(user, targetUserId);

    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(OrderFromDefinitionEntity);
      const item = await repo.findOne({
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
      await this.reconcileDefaultAndMirror(manager, targetUserId, id);
    });
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
      select: ['from'],
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
    mappings: Array<{ sendMethod: IOrderSendMethod | null; fromPhoneNumber: string | null }>,
  ): Promise<void> {
    const needsMms = mappings.some((m) => m.sendMethod === IOrderSendMethod.MMS);
    const approved = needsMms ? await this.getApprovedPhoneSet(billingUserId) : new Set<string>();
    const systemNorm = normalizeFromPhone(systemFromPhoneNumber);

    for (const m of mappings) {
      if (m.sendMethod === IOrderSendMethod.MMS) {
        if (isBlankAfterNormalize(m.fromPhoneNumber)) {
          throw new BadRequestException('발신 번호를 입력해 주세요.');
        }
        // 시스템 기본번호(systemFromPhoneNumber)는 전 계정 암묵 승인 → 별도 등록 없이 허용.
        const norm = normalizeFromPhone(m.fromPhoneNumber);
        if (norm !== systemNorm && !approved.has(norm)) {
          throw new BadRequestException('승인된 발신번호가 아닙니다.');
        }
      } else if (m.sendMethod === IOrderSendMethod.ALIM_TALK) {
        if (isBlankAfterNormalize(m.fromPhoneNumber)) {
          throw new BadRequestException('발신 번호를 입력해 주세요.');
        }
        if (normalizeFromPhone(m.fromPhoneNumber) !== systemNorm) {
          throw new BadRequestException('알림톡 발신번호가 올바르지 않습니다.');
        }
      }
    }
  }

  /**
   * 온보딩/관리자용: 정규화된 from 을 APPROVED isDefault PHONE 으로 보장하고 mirror 동기화.
   * @param manager 호출자 트랜잭션. 주어지면 같은 트랜잭션으로 실행(중첩 금지). 없으면 자체 트랜잭션.
   * @param opts.blankPolicy 'reject'(빈값 400) | 'clear-if-no-approved'(APPROVED 있으면 400, 없으면 mirror NULL)
   * 정책: 유효번호 → find-or-create APPROVED + reconcile. 빈값/시스템번호 → (clear-if-no-approved & APPROVED 0개)만 mirror NULL, APPROVED 존재 시 400. malformed('---') → 항상 400.
   */
  async seedApprovedDefaultPhone(
    userId: number,
    rawFrom: string | null | undefined,
    manager?: EntityManager,
    opts: { blankPolicy?: 'reject' | 'clear-if-no-approved' } = {},
  ): Promise<void> {
    const blankPolicy = opts.blankPolicy ?? 'reject';
    const normFrom = normalizeFromPhone(rawFrom);
    const isSystem = normFrom === normalizeFromPhone(systemFromPhoneNumber);
    const emptyInput = rawFrom === null || rawFrom === undefined || String(rawFrom).trim() === '';
    const malformed = !emptyInput && normFrom.length === 0;

    if (malformed) {
      throw new BadRequestException('발신 번호 형식이 올바르지 않습니다.');
    }

    const isBlankOrSystem = emptyInput || isSystem;

    const run = async (m: EntityManager) => {
      if (isBlankOrSystem) {
        if (blankPolicy === 'reject') {
          throw new BadRequestException('발신 번호를 입력해 주세요.');
        }
        const approvedCount = await m.getRepository(OrderFromDefinitionEntity).count({
          where: {
            type: OrderFromDefinitionType.PHONE,
            userId,
            requestStatus: OrderFromRequestStatus.APPROVED,
            deletedAt: IsNull(),
          },
        });
        if (approvedCount > 0) {
          throw new BadRequestException('승인된 발신번호가 있어 발신번호를 비울 수 없습니다.');
        }
        await m.getRepository(UserEntity).update(userId, { fromPhoneNumber: null });
        return;
      }

      const repo = m.getRepository(OrderFromDefinitionEntity);
      const rows = await repo.find({
        where: { type: OrderFromDefinitionType.PHONE, userId, deletedAt: IsNull() },
      });
      const match = rows.find((r) => normalizeFromPhone(r.from) === normFrom);
      if (match) {
        if (match.requestStatus !== OrderFromRequestStatus.APPROVED) {
          await repo.update(match.id, { requestStatus: OrderFromRequestStatus.APPROVED });
        }
        await this.reconcileDefaultAndMirror(m, userId, match.id);
      } else {
        const inserted = await repo.insert({
          from: normFrom,
          type: OrderFromDefinitionType.PHONE,
          userId,
          requestStatus: OrderFromRequestStatus.APPROVED,
          isDefault: false,
          telecomCertType: TelecomCertType.PRE_DELIVERED,
        });
        const newId = inserted.identifiers[0].id as number;
        await this.reconcileDefaultAndMirror(m, userId, newId);
      }
    };

    if (manager) {
      await run(manager);
    } else {
      await this.dataSource.transaction(run);
    }
  }
}
