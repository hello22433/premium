import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { ApiCustomerMappingEntity } from '../../entity/api.customer.mapping.entity';
import { OrderEntity } from '../../entity/order.entity';
import { UserEntity } from '../../entity/user.entity';
import { IUserStatus } from '../../user/interface/user.status';
import { ExternalApiException } from '../api/external.api.exception.filter';

/**
 * 3계층 매핑모드(PR2) billing user 해석 결과.
 * - billingUser: 실제 차감/정산/발신번호 SoT 가 되는 user(+company 로드).
 * - clientUserId: order.clientUserId 에 적재할 값.
 *   - 단순모드(externalCustomerId 미지정) → null (기존 경로 비트동일).
 *   - 매핑모드 → 매핑된 billingUserId (getBillingUserId(order)=clientUserId ?? userId 로 자동 전파).
 * - externalCustomerId: 정규화된 외부 고객 식별자(추적/적재용). 단순모드는 null.
 */
export interface ResolvedBillingTarget {
  billingUser: UserEntity;
  clientUserId: number | null;
  externalCustomerId: string | null;
}

/**
 * 외부 API 3계층 매핑모드 resolver (PR2 Phase 2).
 *
 * resolve 순서(ralplan 확정):
 *   externalCustomerId 없음/빈문자열 → api_app default billing user (단순모드, clientUserId=null)
 *   externalCustomerId 있고 매핑 없음 → 4xx (4003, default fallback 금지 — fail-closed)
 *   externalCustomerId 있고 매핑 있음 → 매핑 billing user (clientUserId=billingUserId)
 *
 * billingUser 정책범위 검증: 휴면(NOT_USED)/탈퇴(LEAVE) billing user 는 fail-closed 거절.
 */
@Injectable()
export class ApiCustomerMappingResolver {
  constructor(
    @InjectRepository(ApiCustomerMappingEntity)
    private readonly mappingRepository: Repository<ApiCustomerMappingEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    @InjectRepository(OrderEntity)
    private readonly orderRepository: Repository<OrderEntity>,
  ) {}

  async resolveBillingTarget(
    apiAppId: string,
    externalCustomerId: string | null | undefined,
    defaultBillingUserId: number,
  ): Promise<ResolvedBillingTarget> {
    const normalized = externalCustomerId?.trim();

    // 단순모드: externalCustomerId 미지정 → default billing user, clientUserId=null.
    if (!normalized) {
      const billingUser = await this.loadActiveBillingUser(defaultBillingUserId);
      return { billingUser, clientUserId: null, externalCustomerId: null };
    }

    // 매핑모드: (apiAppId, externalCustomerId) 매핑 조회. BaseEntity soft-delete 자동 제외.
    const mapping = await this.mappingRepository.findOne({
      where: { apiAppId, externalCustomerId: normalized },
    });
    // 미등록 → default fallback 금지, fail-closed 4xx.
    if (!mapping) {
      throw new ExternalApiException(
        '4003',
        '등록되지 않은 고객 매핑',
        `미등록 externalCustomerId: ${normalized}`,
      );
    }

    const billingUser = await this.loadActiveBillingUser(mapping.billingUserId);
    return { billingUser, clientUserId: mapping.billingUserId, externalCustomerId: normalized };
  }

  /**
   * 동일 (apiAppId, externalOrderId) 기존 주문 조회.
   * 매핑모드 비즈니스 멱등 보조 — 재요청 시 기존 주문을 반환해 중복 발송/차감을 막는다.
   * (DB UNIQUE(api_app_id, external_order_id) 가 동시성 최종 방어선, 이 조회는 사전 멱등.)
   */
  async findExistingOrderByExternalOrderId(
    apiAppId: string,
    externalOrderId: string | null | undefined,
  ): Promise<OrderEntity | null> {
    const normalized = externalOrderId?.trim();
    if (!normalized) {
      return null;
    }
    return this.orderRepository.findOne({
      where: { apiAppId, externalOrderId: normalized },
    });
  }

  private async loadActiveBillingUser(userId: number, manager?: EntityManager): Promise<UserEntity> {
    const repo = manager ? manager.getRepository(UserEntity) : this.userRepository;
    const billingUser = await repo.findOne({ where: { id: userId }, relations: ['company'] });
    if (!billingUser) {
      throw new ExternalApiException('4003', '등록되지 않은 고객 매핑', `billing user 없음: ${userId}`);
    }
    if (billingUser.status === IUserStatus.NOT_USED || billingUser.status === IUserStatus.LEAVE) {
      throw new ExternalApiException('1001', '비활성 계정입니다.', `billing user 상태: ${billingUser.status}`);
    }
    return billingUser;
  }
}
