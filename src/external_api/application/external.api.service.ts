import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Like, Repository } from 'typeorm';
import { Transactional } from 'typeorm-transactional';
import dayjs from 'dayjs';

import { OrderEntity } from '../../entity/order.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { OrderProductMappingEntity } from '../../entity/order.product.mapping.entity';
import { ProductEntity } from '../../entity/product.entity';
import { UserEntity } from '../../entity/user.entity';
import { UserCompanyEntity } from '../../entity/user.company.entity';
import { DeliverySendHistoryEntity } from '../../entity/delivery.send.history.entity';
import { UserSyncProductEventMappingEntity } from '../../entity/user.sync.product.event.mapping.entity';
import { IUserSyncProductStatus } from '../../user_sync_product/interface/user.sync.product.status';

import { IOrderType } from '../../order/interface/order.type';
import { IOrderStatus } from '../../order/interface/order.status';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { IOrderSendMethod } from '../../order/interface/order.send.method';
import { OrderDeliveryCouponStatus } from '../../delivery/interface/order.delivery.coupon.status';
import { IProductUseStatus } from '../../product/interface/product.status';

import { PartnerCompanyExternService } from '../../partner_company_extern/application/partner.company.extern.service';
import { DeliverySendService } from '../../delivery/application/delivery.send.service';
import { SsgEventService } from '../../ssg_event/application/ssg.event.service';

import { ExternalApiException } from '../api/external.api.exception.filter';
import {
  ExternalApiResponse,
  OrderResponseData,
  OrderStatusResponseData,
  ProductResponseData,
} from '../api/dto/external.api.response.dto';
import { CreateExternalOrderDto, CreateExternalSsgOrderDto } from '../api/dto/external.api.request.dto';

import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { DeliveryCreateCouponImage } from '../../delivery/infra/delivery.create.coupon.image';
import { CreateCode } from '../../common/domain/create.code';
import { OrderPrefixCode, OrderDigitNumber } from '../../order/domain/order.code';
import { CreateTransactionId } from '../../order/domain/create.transaction.id';
import { applyReplaceCharacters } from '../../common/utils/replace-characters.util';

@Injectable()
export class ExternalApiService {
  private readonly logger = new Logger('ExternalApiService');

  constructor(
    @InjectRepository(OrderEntity)
    private orderRepository: Repository<OrderEntity>,
    @InjectRepository(OrderDeliveryEntity)
    private orderDeliveryRepository: Repository<OrderDeliveryEntity>,
    @InjectRepository(OrderProductMappingEntity)
    private orderProductMappingRepository: Repository<OrderProductMappingEntity>,
    @InjectRepository(ProductEntity)
    private productRepository: Repository<ProductEntity>,
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
    @InjectRepository(DeliverySendHistoryEntity)
    private deliverySendHistoryRepository: Repository<DeliverySendHistoryEntity>,
    @InjectRepository(UserSyncProductEventMappingEntity)
    private syncProductEventMappingRepository: Repository<UserSyncProductEventMappingEntity>,
    private dataSource: DataSource,
    private partnerCompanyExternService: PartnerCompanyExternService,
    private deliverySendService: DeliverySendService,
    private ssgEventService: SsgEventService,
    private cryptoCipher: CryptoCipher,
  ) {}

  // ─── 잔액 헬퍼 ──────────────────────────────────────────

  private async deductBalance(user: UserEntity, price: number): Promise<void> {
    const isCompany = user.company?.balanceManagementType === 'COMPANY';
    const result = isCompany
      ? await this.dataSource.query(
          'UPDATE user_company SET balance = balance - ? WHERE id = ? AND balance >= ?',
          [price, user.companyId, price],
        )
      : await this.dataSource.query(
          'UPDATE user SET balance = balance - ? WHERE id = ? AND balance >= ?',
          [price, user.id, price],
        );
    if (result.affectedRows === 0) {
      throw new ExternalApiException('3002', '잔액 부족');
    }
  }

  private async refundBalance(user: UserEntity, price: number): Promise<void> {
    const isCompany = user.company?.balanceManagementType === 'COMPANY';
    if (isCompany) {
      await this.dataSource.query('UPDATE user_company SET balance = balance + ? WHERE id = ?', [price, user.companyId]);
    } else {
      await this.dataSource.query('UPDATE user SET balance = balance + ? WHERE id = ?', [price, user.id]);
    }
  }

  // ─── 할당 상품 헬퍼 ─────────────────────────────────────

  private async getAssignedProductIds(userId: number): Promise<number[]> {
    const mappings = await this.syncProductEventMappingRepository
      .createQueryBuilder('m')
      .innerJoin('m.userSyncProductEvent', 'e')
      .select('m.productId')
      .where('e.businessUserId = :userId', { userId })
      .andWhere('e.status = :status', { status: IUserSyncProductStatus.ACTIVE })
      .andWhere('m.deletedAt IS NULL')
      .getMany();
    return mappings.map((m) => m.productId);
  }

  // ─── 발송 헬퍼 ──────────────────────────────────────────

  private async dispatchSend(
    orderDelivery: OrderDeliveryEntity,
  ): Promise<DeliverySendHistoryEntity> {
    const mapping = orderDelivery.orderProductMapping;
    const product = mapping.product;

    // 수신 대상 복호화
    const decryptedTarget =
      this.cryptoCipher.safeDecryptDeliveryTarget(orderDelivery.deliveryTarget) ?? orderDelivery.deliveryTarget;

    // 발송 텍스트 준비
    let text = mapping.sendContent || '';
    text = applyReplaceCharacters(text, orderDelivery);

    // 암호화 키 생성
    const encryptKey = this.cryptoCipher.encryptJson({
      id: orderDelivery.id,
      transactionId: orderDelivery.transactionId,
    });

    // 발송 이력 준비
    const deliveryHistory = new DeliverySendHistoryEntity();
    deliveryHistory.context = '{}';
    deliveryHistory.isSuccess = true;
    deliveryHistory.target = decryptedTarget;
    deliveryHistory.deliveryMethod = orderDelivery.deliveryMethod;

    // 채널별 발송
    const filePathList = orderDelivery.imagePath ? [orderDelivery.imagePath] : [];
    const title = mapping.sendTitle || product.name;

    if (orderDelivery.deliveryMethod === IOrderSendMethod.ALIM_TALK) {
      await this.deliverySendService.sendAlimTalk(
        orderDelivery, decryptedTarget, encryptKey, title, text, filePathList, deliveryHistory,
      );
    } else if (orderDelivery.deliveryMethod === IOrderSendMethod.MMS) {
      await this.deliverySendService.sendSms(
        orderDelivery, decryptedTarget, encryptKey, title, text, filePathList, deliveryHistory,
      );
    } else if (orderDelivery.deliveryMethod === IOrderSendMethod.EMAIL) {
      await this.deliverySendService.sendEmail(
        orderDelivery, decryptedTarget, encryptKey, title, text, deliveryHistory,
      );
    }

    // 발송 이력 저장
    await this.deliverySendHistoryRepository.save(deliveryHistory);
    return deliveryHistory;
  }

  // ─── 상품 조회 ──────────────────────────────────────────

  async getProducts(user: UserEntity, productCode?: string): Promise<ExternalApiResponse<ProductResponseData[]>> {
    const assignedIds = await this.getAssignedProductIds(user.id);

    if (assignedIds.length === 0) {
      if (productCode) {
        throw new ExternalApiException('3001', '올바르지 못한 요청입니다');
      }
      return ExternalApiResponse.success([]);
    }

    const qb = this.productRepository
      .createQueryBuilder('product')
      .leftJoinAndSelect('product.brand', 'brand')
      .where('product.useStatus = :useStatus', { useStatus: 'USE' })
      .andWhere('product.id IN (:...assignedIds)', { assignedIds });

    if (productCode) {
      qb.andWhere('product.code = :productCode', { productCode });
    }

    const products = await qb.getMany();

    if (productCode && products.length === 0) {
      throw new ExternalApiException('3001', '올바르지 못한 요청입니다');
    }

    const data: ProductResponseData[] = products.map((p) => ({
      productCode: p.code,
      productName: p.name,
      brandName: p.brand?.nameKorean ?? '',
      price: p.price,
      salePrice: p.price,
      imageUrl: p.imagePath,
      validDays: p.expireDay,
    }));

    return ExternalApiResponse.success(data);
  }

  // ─── 주문 생성 (3-phase) ────────────────────────────────

  async createOrder(user: UserEntity, dto: CreateExternalOrderDto): Promise<ExternalApiResponse<OrderResponseData>> {
    // Phase A: DB 트랜잭션 — 주문 생성 + 잔액 차감
    const { order, orderDelivery, mapping, product } = await this.phaseA_createAndDeduct(user, dto);

    const price = product.price;

    // Phase B: 외부 HTTP — 쿠폰 발행 + 발송 (트랜잭션 없음)
    try {
      await this.phaseB_issueAndSend(orderDelivery, user);
    } catch (error) {
      this.logger.error(`[createOrder] Phase B 실패 - trId: ${dto.trId}`, error);
      await this.phaseC_handleFailure(order, orderDelivery, user, price, error);
      throw new ExternalApiException('3003', '쿠폰 발행 실패', error?.message);
    }

    // Phase C: DB 트랜잭션 — 성공 상태 업데이트
    await this.phaseC_handleSuccess(order, orderDelivery);

    return ExternalApiResponse.success<OrderResponseData>({
      trId: dto.trId,
      barCode: orderDelivery.barCode || undefined,
      couponNum: orderDelivery.couponNum || undefined,
      validStartDate: orderDelivery.expireAt ? dayjs().format('YYYY-MM-DD') : undefined,
      validEndDate: orderDelivery.expireAt ? dayjs(orderDelivery.expireAt).format('YYYY-MM-DD') : undefined,
      price,
    });
  }

  // ─── Phase A: 주문 생성 + 잔액 차감 ─────────────────────

  @Transactional()
  private async phaseA_createAndDeduct(user: UserEntity, dto: CreateExternalOrderDto) {
    // 1. 트랜잭션 ID 중복 체크
    const existing = await this.orderDeliveryRepository.findOne({
      where: { externalTrId: dto.trId },
    });
    if (existing) {
      throw new ExternalApiException('2003', '중복 트랜잭션 ID');
    }

    // 2. 상품 조회 + 할당 검증
    const product = await this.productRepository.findOne({
      where: { code: dto.productCode, useStatus: IProductUseStatus.USE },
      relations: ['partnerCompany', 'brand'],
    });
    if (!product) {
      throw new ExternalApiException('3001', '올바르지 못한 요청입니다');
    }

    const assignedIds = await this.getAssignedProductIds(user.id);
    if (!assignedIds.includes(product.id)) {
      throw new ExternalApiException('3001', '올바르지 못한 요청입니다');
    }

    const price = product.price;

    // 3. 원자적 잔액 차감
    await this.deductBalance(user, price);

    // 4. 주문 코드 생성
    const prevOrder = await this.orderRepository.findOne({
      where: { code: Like(`${OrderPrefixCode}%`) },
      order: { code: 'DESC' },
      withDeleted: true,
    });
    const newCode = CreateCode(prevOrder?.code ?? null, OrderPrefixCode, OrderDigitNumber);

    // 5. 주문 생성
    const order = this.orderRepository.create({
      userId: user.id,
      code: newCode,
      type: IOrderType.EXTERNAL,
      status: IOrderStatus.DELIVERY_REQUEST,
      eventName: `외부주문-${dto.trId}`,
      registerAt: new Date(),
      sendAmount: price,
      settleAmount: price,
      isNewBillingFlow: false,
      isSettleBalance: true,
      isSettleComplete: false,
      clientUserId: null,
    });
    await this.orderRepository.save(order);

    // 6. 주문-상품 매핑 생성
    const mapping = this.orderProductMappingRepository.create({
      orderId: order.id,
      productId: product.id,
      amount: 1,
      sendContent: dto.message || '',
      sendTitle: dto.title || product.name,
      fromPhoneNumber: dto.senderPhone,
      sendMethod: dto.deliveryMethod as IOrderSendMethod,
      topImagePath: '',
      midImagePath: '',
    });
    await this.orderProductMappingRepository.save(mapping);

    // 7. 배송 건 생성 (externalTrId를 create에서 설정)
    const orderDelivery = this.orderDeliveryRepository.create({
      orderProductMappingId: mapping.id,
      status: IOrderDeliveryStatus.WAIT,
      deliveryMethod: dto.deliveryMethod as IOrderSendMethod,
      deliveryTarget: this.cryptoCipher.encryptDeliveryTarget(dto.recipientPhone),
      originalDeliveryTarget: this.cryptoCipher.encryptDeliveryTarget(dto.recipientPhone),
      sendRequestAt: new Date(),
      externalTrId: dto.trId,
    });
    await this.orderDeliveryRepository.save(orderDelivery);

    // 8. 관계 설정 (phaseB에서 재조립 불필요)
    mapping.product = product;
    mapping.order = order;
    order.user = user;
    orderDelivery.orderProductMapping = mapping;

    return { order, orderDelivery, mapping, product };
  }

  // ─── Phase B: 쿠폰 발행 + 발송 (트랜잭션 없음) ──────────

  private async phaseB_issueAndSend(
    orderDelivery: OrderDeliveryEntity,
    user: UserEntity,
  ) {
    const mapping = orderDelivery.orderProductMapping;
    const product = mapping.product;

    // 1. 쿠폰(PIN) 발행
    await this.partnerCompanyExternService.issue(orderDelivery, null);

    // 2. 쿠폰 이미지 생성 (barCode가 있는 경우)
    if (orderDelivery.barCode) {
      const expireDate = orderDelivery.expireAt
        ? dayjs(orderDelivery.expireAt).format('YYYY. MM. DD')
        : null;
      const { path } = await DeliveryCreateCouponImage(
        product.imagePath,
        product.name,
        orderDelivery.barCode,
        product.brand?.nameKorean || '',
        expireDate,
        mapping.topImagePath || '',
        mapping.midImagePath || '',
        product.type,
      );
      orderDelivery.imagePath = path;
    }

    // 3. 발송
    const deliveryHistory = await this.dispatchSend(orderDelivery);

    // 발송 실패 시 에러 throw
    if (!deliveryHistory.isSuccess) {
      throw new Error('발송 실패');
    }

    return { orderDelivery, deliveryHistory };
  }

  // ─── Phase C: 성공 상태 업데이트 ─────────────────────────

  @Transactional()
  private async phaseC_handleSuccess(order: OrderEntity, orderDelivery: OrderDeliveryEntity) {
    // deliverySendService.markSendSuccess가 이미 status를 설정했으므로 저장만 수행
    if (!orderDelivery.actualSendAt) {
      orderDelivery.actualSendAt = new Date();
    }
    await this.orderDeliveryRepository.save(orderDelivery);

    order.status = IOrderStatus.DELIVERY_COMPLETE;
    await this.orderRepository.save(order);
  }

  // ─── Phase C: 실패 처리 + 환불 ──────────────────────────

  @Transactional()
  private async phaseC_handleFailure(
    order: OrderEntity,
    orderDelivery: OrderDeliveryEntity,
    user: UserEntity,
    price: number,
    error: any,
  ) {
    orderDelivery.status = IOrderDeliveryStatus.FAIL;
    orderDelivery.apiErrorMessage = error?.message?.substring(0, 500) ?? null;
    if (!orderDelivery.failedAt) {
      orderDelivery.failedAt = new Date();
    }
    await this.orderDeliveryRepository.save(orderDelivery);

    order.status = IOrderStatus.DELIVERY_CANCEL;
    await this.orderRepository.save(order);

    // 잔액 환불
    await this.refundBalance(user, price);
  }

  // ─── 주문 상태 조회 ─────────────────────────────────────

  async getOrderStatus(user: UserEntity, trId: string): Promise<ExternalApiResponse<OrderStatusResponseData>> {
    const orderDelivery = await this.findOrderDeliveryByTrId(user, trId);

    const product = orderDelivery.orderProductMapping?.product;
    const price = product?.price ?? 0;

    return ExternalApiResponse.success<OrderStatusResponseData>({
      trId,
      couponStatus: orderDelivery.couponStatus,
      deliveryStatus: orderDelivery.status,
      barCode: orderDelivery.barCode || undefined,
      couponNum: orderDelivery.couponNum || undefined,
      validStartDate: orderDelivery.expireAt ? dayjs(orderDelivery.sendRequestAt).format('YYYY-MM-DD') : undefined,
      validEndDate: orderDelivery.expireAt ? dayjs(orderDelivery.expireAt).format('YYYY-MM-DD') : undefined,
      price,
    });
  }

  // ─── 주문 취소 ──────────────────────────────────────────

  async cancelOrder(user: UserEntity, trId: string): Promise<ExternalApiResponse> {
    const orderDelivery = await this.findOrderDeliveryByTrId(user, trId);
    const mapping = orderDelivery.orderProductMapping;
    const order = mapping.order;
    const product = mapping.product;
    const price = product?.price ?? 0;

    // 이미 취소된 경우
    if (orderDelivery.status === IOrderDeliveryStatus.CANCEL) {
      throw new ExternalApiException('3005', '이미 취소된 주문');
    }

    // 쿠폰이 사용된 경우 취소 불가
    if (orderDelivery.couponStatus === OrderDeliveryCouponStatus.USED) {
      throw new ExternalApiException('3006', '이미 사용된 쿠폰은 취소 불가');
    }

    // 쿠폰 취소 (barCode가 있는 경우 협력사 API 호출)
    if (orderDelivery.barCode && product?.partnerCompany) {
      try {
        await this.partnerCompanyExternService.cancel(orderDelivery);
      } catch (error) {
        this.logger.error(`[cancelOrder] 쿠폰 취소 실패 - trId: ${trId}`, error);
        throw new ExternalApiException('3004', '쿠폰 취소 실패', error?.message);
      }
    }

    // 상태 업데이트 + 환불
    await this.processCancelRefund(order, orderDelivery, user, price);

    return ExternalApiResponse.success();
  }

  @Transactional()
  private async processCancelRefund(
    order: OrderEntity,
    orderDelivery: OrderDeliveryEntity,
    user: UserEntity,
    price: number,
  ) {
    orderDelivery.status = IOrderDeliveryStatus.CANCEL;
    orderDelivery.couponStatus = OrderDeliveryCouponStatus.CANCEL;
    await this.orderDeliveryRepository.save(orderDelivery);

    order.status = IOrderStatus.DELIVERY_CANCEL;
    await this.orderRepository.save(order);

    // 잔액 환불
    await this.refundBalance(user, price);
  }

  // ─── 재발송 ─────────────────────────────────────────────

  async resendOrder(user: UserEntity, trId: string): Promise<ExternalApiResponse> {
    const orderDelivery = await this.findOrderDeliveryByTrId(user, trId);

    if (!orderDelivery.barCode) {
      throw new ExternalApiException('3004', '발행된 쿠폰이 없어 재발송 불가');
    }

    // 발송
    await this.dispatchSend(orderDelivery);

    // 재발송 시각 기록
    orderDelivery.resendAt = new Date();
    await this.orderDeliveryRepository.save(orderDelivery);

    return ExternalApiResponse.success();
  }

  // ─── SSG 주문 생성 ──────────────────────────────────────

  async createSsgOrder(user: UserEntity, dto: CreateExternalSsgOrderDto): Promise<ExternalApiResponse<OrderResponseData>> {
    // Phase A: DB 트랜잭션 — 주문 생성 + 잔액 차감
    const { order, orderDelivery, mapping, product, ssgEvent } = await this.phaseA_createSsgAndDeduct(user, dto);

    const price = dto.amount;

    // Phase B: 외부 HTTP — SSG 쿠폰 발행 + 발송
    try {
      await this.phaseB_issueAndSend(orderDelivery, user);
    } catch (error) {
      this.logger.error(`[createSsgOrder] Phase B 실패 - trId: ${dto.trId}`, error);
      await this.phaseC_handleFailure(order, orderDelivery, user, price, error);
      throw new ExternalApiException('3003', 'SSG 쿠폰 발행 실패', error?.message);
    }

    // Phase C: 성공 상태 업데이트
    await this.phaseC_handleSuccess(order, orderDelivery);

    return ExternalApiResponse.success<OrderResponseData>({
      trId: dto.trId,
      barCode: orderDelivery.barCode || undefined,
      couponNum: orderDelivery.couponNum || undefined,
      validStartDate: orderDelivery.expireAt ? dayjs().format('YYYY-MM-DD') : undefined,
      validEndDate: orderDelivery.expireAt ? dayjs(orderDelivery.expireAt).format('YYYY-MM-DD') : undefined,
      price,
    });
  }

  @Transactional()
  private async phaseA_createSsgAndDeduct(user: UserEntity, dto: CreateExternalSsgOrderDto) {
    // 1. 트랜잭션 ID 중복 체크
    const existing = await this.orderDeliveryRepository.findOne({
      where: { externalTrId: dto.trId },
    });
    if (existing) {
      throw new ExternalApiException('2003', '중복 트랜잭션 ID');
    }

    // 2. SSG 이벤트 할당
    const price = dto.amount;
    const deliveryPlaceholder = [{ deliveryId: 0, price }];
    const ssgAllocations = await this.ssgEventService.allocateEventsForDeliveries(deliveryPlaceholder, 90);
    if (!ssgAllocations) {
      throw new ExternalApiException('3002', 'SSG 이벤트 잔액 부족');
    }

    const ssgEvent = ssgAllocations[0];

    // 3. SSG 이벤트에서 상품 조회
    const product = await this.productRepository.findOne({
      where: { type: 'SSG' as any },
      relations: ['partnerCompany', 'brand'],
    });
    if (!product) {
      throw new ExternalApiException('3001', 'SSG 상품 없음');
    }

    // 4. 잔액 차감
    await this.deductBalance(user, price);

    // 5. 주문 코드 생성
    const prevOrder = await this.orderRepository.findOne({
      where: { code: Like(`${OrderPrefixCode}%`) },
      order: { code: 'DESC' },
      withDeleted: true,
    });
    const newCode = CreateCode(prevOrder?.code ?? null, OrderPrefixCode, OrderDigitNumber);

    // 6. 주문 생성
    const order = this.orderRepository.create({
      userId: user.id,
      code: newCode,
      type: IOrderType.SSG,
      status: IOrderStatus.DELIVERY_REQUEST,
      eventName: `외부SSG주문-${dto.trId}`,
      registerAt: new Date(),
      sendAmount: price,
      settleAmount: price,
      isNewBillingFlow: false,
      isSettleBalance: true,
      isSettleComplete: false,
      ssgEventId: ssgEvent.eventId,
      clientUserId: null,
    });
    await this.orderRepository.save(order);

    // 7. 주문-상품 매핑
    const mapping = this.orderProductMappingRepository.create({
      orderId: order.id,
      productId: product.id,
      amount: 1,
      sendContent: dto.message || '',
      sendTitle: product.name,
      fromPhoneNumber: dto.senderPhone || null,
      sendMethod: IOrderSendMethod.ALIM_TALK,
      topImagePath: '',
      midImagePath: '',
    });
    await this.orderProductMappingRepository.save(mapping);

    // 8. 배송 건 생성 (externalTrId를 create에서 설정)
    const orderDelivery = this.orderDeliveryRepository.create({
      orderProductMappingId: mapping.id,
      status: IOrderDeliveryStatus.WAIT,
      deliveryMethod: IOrderSendMethod.ALIM_TALK,
      deliveryTarget: this.cryptoCipher.encryptDeliveryTarget(dto.recipientPhone),
      originalDeliveryTarget: this.cryptoCipher.encryptDeliveryTarget(dto.recipientPhone),
      sendRequestAt: new Date(),
      ssgEventId: ssgEvent.eventId,
      externalTrId: dto.trId,
    });
    await this.orderDeliveryRepository.save(orderDelivery);

    // 9. SSG 이벤트 잔액 차감
    await this.ssgEventService.deductEventBalanceMultiple(ssgAllocations, order.id, false);

    // 10. 관계 설정 (phaseB에서 재조립 불필요)
    mapping.product = product;
    mapping.order = order;
    order.user = user;
    orderDelivery.orderProductMapping = mapping;

    return { order, orderDelivery, mapping, product, ssgEvent };
  }

  // ─── 공통 유틸 ──────────────────────────────────────────

  private async findOrderDeliveryByTrId(user: UserEntity, trId: string): Promise<OrderDeliveryEntity> {
    const orderDelivery = await this.orderDeliveryRepository.findOne({
      where: { externalTrId: trId },
      relations: [
        'orderProductMapping',
        'orderProductMapping.order',
        'orderProductMapping.product',
        'orderProductMapping.product.partnerCompany',
        'orderProductMapping.product.brand',
      ],
    });

    if (!orderDelivery) {
      throw new ExternalApiException('4001', '주문을 찾을 수 없음');
    }

    const order = orderDelivery.orderProductMapping?.order;
    if (!order || order.userId !== user.id) {
      throw new ExternalApiException('4002', '주문에 대한 접근 권한 없음');
    }

    return orderDelivery;
  }
}
