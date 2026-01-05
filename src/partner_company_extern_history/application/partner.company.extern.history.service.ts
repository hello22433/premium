import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PartnerCompanyExternHistoryEntity } from '../../entity/partner.company.extern.history.entity';
import { GetPartnerCompanyExternHistoryListReqDto } from '../api/partner.company.extern.history.req.dto';
import {
  GetPartnerCompanyExternHistoryListResDto,
  PartnerCompanyExternHistoryViewDto,
  GetPartnerCompanyTypesResDto,
} from '../api/partner.company.extern.history.res.dto';
import { format } from 'date-fns';
import { DateFormatStr } from '../../common/domain/date.format.str';
import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';
import { CryptoCipher } from '../../common/infra/crypto.cipher';

// 협력사 타입 한글 매핑
const PartnerCompanyTypeKo: Record<IPartnerCompanyType, string> = {
  [IPartnerCompanyType.GIFT_SHOW]: 'KT알파 (기프티쇼)',
  [IPartnerCompanyType.GS_M_BIZ]: 'GS 엠비즈',
  [IPartnerCompanyType.GIFTIEL]: '대홍기획 (기프티엘)',
  [IPartnerCompanyType.CULTURELAND]: '컬쳐랜드',
  [IPartnerCompanyType.GALAXIA]: '갤럭시아',
  [IPartnerCompanyType.SSG]: '신세계',
  [IPartnerCompanyType.DAOU]: '다우기술',
};

@Injectable()
export class PartnerCompanyExternHistoryService {
  constructor(
    @InjectRepository(PartnerCompanyExternHistoryEntity)
    private historyRepository: Repository<PartnerCompanyExternHistoryEntity>,
    private cryptoCipher: CryptoCipher,
  ) {}

  /**
   * 발송 실패/성공 내역 목록 조회
   */
  async getHistoryList(dto: GetPartnerCompanyExternHistoryListReqDto): Promise<GetPartnerCompanyExternHistoryListResDto> {
    const { startAt, endAt, type, isSuccess, searchKeyword, page, take } = dto;

    let queryBuilder = this.historyRepository
      .createQueryBuilder('history')
      .leftJoinAndSelect('history.orderDelivery', 'orderDelivery')
      .leftJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .leftJoinAndSelect('orderProductMapping.order', 'order')
      .where('history.deletedAt IS NULL');

    // 기간 필터
    if (startAt) {
      queryBuilder.andWhere('history.createdAt >= :startAt', { startAt: `${startAt} 00:00:00` });
    }
    if (endAt) {
      queryBuilder.andWhere('history.createdAt <= :endAt', { endAt: `${endAt} 23:59:59` });
    }

    // 협력사 타입 필터
    if (type) {
      queryBuilder.andWhere('history.type = :type', { type });
    }

    // 성공/실패 필터
    if (typeof isSuccess === 'boolean') {
      queryBuilder.andWhere('history.isSuccess = :isSuccess', { isSuccess });
    }

    // 키워드 검색 (context 내)
    if (searchKeyword) {
      queryBuilder.andWhere('history.context LIKE :searchKeyword', {
        searchKeyword: `%${searchKeyword}%`,
      });
    }

    // 페이징 및 정렬
    const skip = (page - 1) * take;
    queryBuilder.orderBy('history.createdAt', 'DESC').skip(skip).take(take);

    const [histories, totalCount] = await queryBuilder.getManyAndCount();

    // DTO 변환
    const list: PartnerCompanyExternHistoryViewDto[] = histories.map((h) => this.parseHistoryView(h));

    return {
      list,
      totalCount,
      totalPage: Math.ceil(totalCount / take),
      currentPage: page,
    };
  }

  /**
   * 협력사 타입 목록 조회 (드롭다운용)
   */
  async getPartnerCompanyTypes(): Promise<GetPartnerCompanyTypesResDto> {
    const types = Object.entries(PartnerCompanyTypeKo).map(([value, label]) => ({
      value,
      label,
    }));

    return { types };
  }

  /**
   * 히스토리 엔티티를 View DTO로 변환
   */
  private parseHistoryView(history: PartnerCompanyExternHistoryEntity): PartnerCompanyExternHistoryViewDto {
    let errorCode: string | null = null;
    let errorMessage: string | null = null;
    let transactionId: string | null = null;

    // context JSON 파싱하여 에러 정보 추출
    try {
      const context = JSON.parse(history.context);

      // 각 협력사별로 다른 필드명을 가질 수 있으므로 다양한 경우 처리
      errorCode = context.errorCode || context.resultCode || context.code || context.resCode || null;
      errorMessage =
        context.errorMessage ||
        context.resultMessage ||
        context.message ||
        context.resMsg ||
        context.msg ||
        null;
      transactionId = context.transactionId || context.trId || context.tradeNo || null;
    } catch (e) {
      // JSON 파싱 실패 시 무시
    }

    // order 정보 추출
    let orderCode: string | null = null;
    let eventName: string | null = null;
    let deliveryTarget: string | null = null;

    if (history.orderDelivery) {
      const orderDelivery = history.orderDelivery;

      // 수신처 마스킹 처리
      if (orderDelivery.deliveryTarget) {
        try {
          const decrypted = this.cryptoCipher.decryptDeliveryTarget(orderDelivery.deliveryTarget);
          deliveryTarget = this.maskDeliveryTarget(decrypted);
        } catch {
          deliveryTarget = this.maskDeliveryTarget(orderDelivery.deliveryTarget);
        }
      }

      if (orderDelivery.orderProductMapping?.order) {
        const order = orderDelivery.orderProductMapping.order;
        orderCode = order.code;
        eventName = order.eventName;
      }
    }

    return {
      id: history.id,
      createdAt: format(history.createdAt, DateFormatStr),
      type: history.type,
      typeKo: PartnerCompanyTypeKo[history.type] || history.type,
      isSuccess: history.isSuccess,
      errorCode,
      errorMessage,
      transactionId,
      context: history.context,
      orderDeliveryId: history.orderDeliveryId,
      orderCode,
      eventName,
      deliveryTarget,
    };
  }

  /**
   * 수신처 마스킹 처리
   */
  private maskDeliveryTarget(target: string): string {
    if (!target) return '';

    // 이메일인 경우
    if (target.includes('@')) {
      const [local, domain] = target.split('@');
      if (local.length <= 2) {
        return `${local[0]}*@${domain}`;
      }
      return `${local.substring(0, 2)}${'*'.repeat(local.length - 2)}@${domain}`;
    }

    // 전화번호인 경우 (숫자만 있는 경우)
    if (/^\d+$/.test(target)) {
      if (target.length <= 4) return target;
      const start = target.substring(0, 3);
      const end = target.substring(target.length - 4);
      return `${start}****${end}`;
    }

    // 기타
    if (target.length <= 4) return target;
    return `${target.substring(0, 2)}${'*'.repeat(target.length - 4)}${target.substring(target.length - 2)}`;
  }
}