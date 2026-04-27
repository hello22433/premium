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
import { DeliverySendHistoryEntity } from '../../entity/delivery.send.history.entity';
import { UserSyncProductEventMappingEntity } from '../../entity/user.sync.product.event.mapping.entity';
import { ExternalApiAccountEntity } from '../../entity/external.api.account.entity';
import { IUserSyncProductStatus } from '../../user_sync_product/interface/user.sync.product.status';
import { IUserAuthority } from '../../user/interface/user.authority';

import { IOrderType } from '../../order/interface/order.type';
import { IOrderStatus } from '../../order/interface/order.status';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { IOrderSendMethod } from '../../order/interface/order.send.method';
import { OrderDeliveryCouponStatus } from '../../delivery/interface/order.delivery.coupon.status';
import { IProductUseStatus } from '../../product/interface/product.status';
import { IProductType } from '../../product/interface/product.type';

import { PartnerCompanyExternService } from '../../partner_company_extern/application/partner.company.extern.service';
import { DeliverySendService } from '../../delivery/application/delivery.send.service';
import { SsgEventService } from '../../ssg_event/application/ssg.event.service';

import { ExternalApiException } from '../api/external.api.exception.filter';
import {
  ExternalApiResponse,
  OrderResponseData,
  SsgOrderResponseData,
  OrderStatusResponseData,
  SsgOrderStatusResponseData,
  ProductResponseData,
} from '../api/dto/external.api.response.dto';
import { CreateExternalOrderDto, CreateExternalSsgOrderDto } from '../api/dto/external.api.request.dto';

import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { DeliveryCreateCouponImage } from '../../delivery/infra/delivery.create.coupon.image';
import { CreateCode } from '../../common/domain/create.code';
import { OrderPrefixCode, OrderDigitNumber } from '../../order/domain/order.code';
import { CreateApiTransactionId } from '../../order/domain/create.transaction.id';
import { applyReplaceCharacters } from '../../common/utils/replace-characters.util';
import { ulid } from 'ulid';

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
  // 잔액 차감 위치는 user.company.balanceManagementType으로 분기.
  //   COMPANY → user_company.balance (회사 단위 정산)
  //   그 외(PERSONAL) → user.balance (계정 단위 정산)

  private async deductBalance(account: ExternalApiAccountEntity, price: number): Promise<void> {
    const user = account.user;
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

  private async refundBalance(account: ExternalApiAccountEntity, price: number): Promise<void> {
    const user = account.user;
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

    const decryptedTarget =
      this.cryptoCipher.safeDecryptDeliveryTarget(orderDelivery.deliveryTarget) ?? orderDelivery.deliveryTarget;

    let text = mapping.sendContent || '';
    text = applyReplaceCharacters(text, orderDelivery);

    const encryptKey = this.cryptoCipher.encryptJson({
      id: orderDelivery.id,
      transactionId: orderDelivery.transactionId,
    });

    const deliveryHistory = new DeliverySendHistoryEntity();
    deliveryHistory.context = '{}';
    deliveryHistory.isSuccess = true;
    deliveryHistory.target = decryptedTarget;
    deliveryHistory.deliveryMethod = orderDelivery.deliveryMethod;

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

    await this.deliverySendHistoryRepository.save(deliveryHistory);
    return deliveryHistory;
  }

  // ─── 재발송 한도 ────────────────────────────────────────

  private resolveResendMax(account: ExternalApiAccountEntity): number {
    const fallback = Number(process.env.EXTERNAL_API_RESEND_MAX_DEFAULT ?? 3);
    return account.resendMaxCount ?? fallback;
  }

  // ─── 상품 조회 ──────────────────────────────────────────

  async getProducts(account: ExternalApiAccountEntity, productCode?: string): Promise<ExternalApiResponse<ProductResponseData[]>> {
    const user = account.user;
    const isSuperAdmin = user.authority === IUserAuthority.SUPER_ADMIN;

    const qb = this.productRepository
      .createQueryBuilder('product')
      .leftJoinAndSelect('product.brand', 'brand')
      .where('product.useStatus = :useStatus', { useStatus: 'USE' });

    if (!isSuperAdmin) {
      const assignedIds = await this.getAssignedProductIds(user.id);

      if (assignedIds.length === 0) {
        if (productCode) {
          throw new ExternalApiException('3001', '올바르지 못한 요청입니다');
        }
        return ExternalApiResponse.success([]);
      }

      qb.andWhere('product.id IN (:...assignedIds)', { assignedIds });
    }

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

  async createOrder(account: ExternalApiAccountEntity, dto: CreateExternalOrderDto): Promise<ExternalApiResponse<OrderResponseData>> {
    const { order, orderDelivery, product } = await this.phaseA_createAndDeduct(account, dto);

    const externalTrId = orderDelivery.externalTrId!;
    const price = product.price;

    try {
      await this.phaseB_issueAndSend(orderDelivery);
    } catch (error) {
      this.logger.error(`[createOrder] Phase B 실패 - externalTrId: ${externalTrId}`, error);
      await this.phaseC_handleFailure(order, orderDelivery, account, price, error);
      throw new ExternalApiException('3003', '쿠폰 발행 실패', error?.message);
    }

    await this.phaseC_handleSuccess(order, orderDelivery);

    return ExternalApiResponse.success<OrderResponseData>({
      trId: externalTrId,
      barCode: orderDelivery.barCode || undefined,
      validStartDate: orderDelivery.expireAt ? dayjs().format('YYYY-MM-DD') : undefined,
      validEndDate: orderDelivery.expireAt ? dayjs(orderDelivery.expireAt).format('YYYY-MM-DD') : undefined,
      price,
    });
  }

  // ─── Phase A: 주문 생성 + 잔액 차감 ─────────────────────

  @Transactional()
  private async phaseA_createAndDeduct(account: ExternalApiAccountEntity, dto: CreateExternalOrderDto) {
    const user = account.user;

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

    await this.deductBalance(account, price);

    const prevOrder = await this.orderRepository.findOne({
      where: { code: Like(`${OrderPrefixCode}%`) },
      order: { code: 'DESC' },
      withDeleted: true,
    });
    const newCode = CreateCode(prevOrder?.code ?? null, OrderPrefixCode, OrderDigitNumber);

    const order = this.orderRepository.create({
      userId: user.id,
      code: newCode,
      type: IOrderType.EXTERNAL,
      status: IOrderStatus.DELIVERY_REQUEST,
      eventName: `외부주문`,
      registerAt: new Date(),
      sendAmount: price,
      settleAmount: price,
      isNewBillingFlow: false,
      isSettleBalance: true,
      isSettleComplete: false,
      clientUserId: null,
    });
    await this.orderRepository.save(order);

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

    const orderDelivery = this.orderDeliveryRepository.create({
      orderProductMappingId: mapping.id,
      status: IOrderDeliveryStatus.WAIT,
      deliveryMethod: dto.deliveryMethod as IOrderSendMethod,
      deliveryTarget: this.cryptoCipher.encryptDeliveryTarget(dto.recipientPhone),
      originalDeliveryTarget: this.cryptoCipher.encryptDeliveryTarget(dto.recipientPhone),
      sendRequestAt: new Date(),
    });
    await this.orderDeliveryRepository.save(orderDelivery);

    orderDelivery.transactionId = CreateApiTransactionId(order.id, orderDelivery.id);
    orderDelivery.externalTrId = await this.saveTransactionIds(orderDelivery.id, orderDelivery.transactionId);

    mapping.product = product;
    mapping.order = order;
    order.user = user;
    orderDelivery.orderProductMapping = mapping;

    return { order, orderDelivery, mapping, product };
  }

  // ─── Phase B: 쿠폰 발행 + 발송 (트랜잭션 없음) ──────────

  private async phaseB_issueAndSend(orderDelivery: OrderDeliveryEntity) {
    const mapping = orderDelivery.orderProductMapping;
    const product = mapping.product;

    await this.partnerCompanyExternService.issue(orderDelivery, null);

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

    const deliveryHistory = await this.dispatchSend(orderDelivery);

    if (!deliveryHistory.isSuccess) {
      throw new Error('발송 실패');
    }

    return { orderDelivery, deliveryHistory };
  }

  // ─── Phase C: 성공 상태 업데이트 ─────────────────────────

  @Transactional()
  private async phaseC_handleSuccess(order: OrderEntity, orderDelivery: OrderDeliveryEntity) {
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
    account: ExternalApiAccountEntity,
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

    await this.refundBalance(account, price);
  }

  // ─── 주문 상태 조회 ─────────────────────────────────────

  async getOrderStatus(account: ExternalApiAccountEntity, trId: string): Promise<ExternalApiResponse<OrderStatusResponseData>> {
    const orderDelivery = await this.findOrderDeliveryByTrId(account, trId);

    const product = orderDelivery.orderProductMapping?.product;
    const price = product?.price ?? 0;

    return ExternalApiResponse.success<OrderStatusResponseData>({
      trId: orderDelivery.externalTrId!,
      couponStatus: orderDelivery.couponStatus,
      deliveryStatus: orderDelivery.status,
      barCode: orderDelivery.barCode || undefined,
      validStartDate: orderDelivery.expireAt ? dayjs(orderDelivery.sendRequestAt).format('YYYY-MM-DD') : undefined,
      validEndDate: orderDelivery.expireAt ? dayjs(orderDelivery.expireAt).format('YYYY-MM-DD') : undefined,
      price,
    });
  }

  // ─── SSG 주문 상태 조회 ─────────────────────────────────

  async getSsgOrderStatus(account: ExternalApiAccountEntity, trId: string): Promise<ExternalApiResponse<SsgOrderStatusResponseData>> {
    const orderDelivery = await this.findOrderDeliveryByTrId(account, trId);

    const product = orderDelivery.orderProductMapping?.product;
    const price = product?.price ?? 0;

    return ExternalApiResponse.success<SsgOrderStatusResponseData>({
      trId: orderDelivery.externalTrId!,
      couponStatus: orderDelivery.couponStatus,
      deliveryStatus: orderDelivery.status,
      barCode: orderDelivery.barCode || undefined,
      personalCode: orderDelivery.personalCode || undefined,
      validStartDate: orderDelivery.expireAt ? dayjs(orderDelivery.sendRequestAt).format('YYYY-MM-DD') : undefined,
      validEndDate: orderDelivery.expireAt ? dayjs(orderDelivery.expireAt).format('YYYY-MM-DD') : undefined,
      price,
    });
  }

  // ─── 주문 취소 ──────────────────────────────────────────

  async cancelOrder(account: ExternalApiAccountEntity, trId: string): Promise<ExternalApiResponse> {
    const orderDelivery = await this.findOrderDeliveryByTrId(account, trId);
    const mapping = orderDelivery.orderProductMapping;
    const order = mapping.order;
    const product = mapping.product;
    const price = product?.price ?? 0;

    if (orderDelivery.status === IOrderDeliveryStatus.CANCEL) {
      throw new ExternalApiException('3005', '이미 취소된 주문');
    }

    if (orderDelivery.couponStatus === OrderDeliveryCouponStatus.USED) {
      throw new ExternalApiException('3006', '이미 사용된 쿠폰은 취소 불가');
    }

    if (orderDelivery.expireAt && orderDelivery.expireAt.getTime() < Date.now()) {
      throw new ExternalApiException('3007', '만료된 쿠폰');
    }

    if (product && product.isCancelable === false) {
      throw new ExternalApiException('3009', '취소 불가 상품');
    }

    if (orderDelivery.barCode && product?.partnerCompany) {
      try {
        await this.partnerCompanyExternService.cancelByExternalApi(orderDelivery);
      } catch (error) {
        this.logger.error(`[cancelOrder] 쿠폰 취소 실패 - trId: ${trId}`, error);
        throw new ExternalApiException('3004', '쿠폰 취소 실패', error?.message);
      }
    }

    await this.processCancelRefund(order, orderDelivery, account, price);

    return ExternalApiResponse.success();
  }

  @Transactional()
  private async processCancelRefund(
    order: OrderEntity,
    orderDelivery: OrderDeliveryEntity,
    account: ExternalApiAccountEntity,
    price: number,
  ) {
    orderDelivery.status = IOrderDeliveryStatus.CANCEL;
    orderDelivery.couponStatus = OrderDeliveryCouponStatus.CANCEL;
    await this.orderDeliveryRepository.save(orderDelivery);

    order.status = IOrderStatus.DELIVERY_CANCEL;
    await this.orderRepository.save(order);

    await this.refundBalance(account, price);
  }

  // ─── 재발송 ─────────────────────────────────────────────

  async resendOrder(account: ExternalApiAccountEntity, trId: string): Promise<ExternalApiResponse> {
    const orderDelivery = await this.findOrderDeliveryByTrId(account, trId);

    if (!orderDelivery.barCode) {
      throw new ExternalApiException('3004', '발행된 쿠폰이 없어 재발송 불가');
    }

    const max = this.resolveResendMax(account);
    if (orderDelivery.resendCount >= max) {
      throw new ExternalApiException(
        '3008',
        `재발송 횟수 초과 (${orderDelivery.resendCount}/${max})`,
      );
    }

    const history = await this.dispatchSend(orderDelivery);
    if (!history.isSuccess) {
      throw new ExternalApiException('3003', '재발송 실패');
    }

    orderDelivery.resendAt = new Date();
    orderDelivery.resendCount = orderDelivery.resendCount + 1;
    await this.orderDeliveryRepository.save(orderDelivery);

    return ExternalApiResponse.success();
  }

  // ─── SSG 주문 생성 ──────────────────────────────────────

  async createSsgOrder(account: ExternalApiAccountEntity, dto: CreateExternalSsgOrderDto): Promise<ExternalApiResponse<SsgOrderResponseData>> {
    if (!account.ssgEnabled) {
      throw new ExternalApiException('1005', 'SSG 미승인 계정');
    }

    const { order, orderDelivery } = await this.phaseA_createSsgAndDeduct(account, dto);

    const externalTrId = orderDelivery.externalTrId!;
    const price = dto.amount;

    try {
      await this.phaseB_issueAndSend(orderDelivery);
    } catch (error) {
      this.logger.error(`[createSsgOrder] Phase B 실패 - externalTrId: ${externalTrId}`, error);
      await this.phaseC_handleFailure(order, orderDelivery, account, price, error);
      throw new ExternalApiException('3003', 'SSG 쿠폰 발행 실패', error?.message);
    }

    await this.phaseC_handleSuccess(order, orderDelivery);

    return ExternalApiResponse.success<SsgOrderResponseData>({
      trId: externalTrId,
      barCode: orderDelivery.barCode || undefined,
      personalCode: orderDelivery.personalCode || undefined,
      validStartDate: orderDelivery.expireAt ? dayjs().format('YYYY-MM-DD') : undefined,
      validEndDate: orderDelivery.expireAt ? dayjs(orderDelivery.expireAt).format('YYYY-MM-DD') : undefined,
      price,
    });
  }

  @Transactional()
  private async phaseA_createSsgAndDeduct(account: ExternalApiAccountEntity, dto: CreateExternalSsgOrderDto) {
    const user = account.user;
    const price = dto.amount;
    const deliveryPlaceholder = [{ deliveryId: 0, price }];
    const ssgAllocations = await this.ssgEventService.allocateEventsForDeliveries(deliveryPlaceholder, 90);
    if (!ssgAllocations) {
      throw new ExternalApiException('3002', 'SSG 이벤트 잔액 부족');
    }

    const ssgEvent = ssgAllocations[0];

    const product = await this.productRepository.findOne({
      where: { type: IProductType.SSG },
      relations: ['partnerCompany', 'brand'],
    });
    if (!product) {
      throw new ExternalApiException('3001', 'SSG 상품 없음');
    }

    await this.deductBalance(account, price);

    const prevOrder = await this.orderRepository.findOne({
      where: { code: Like(`${OrderPrefixCode}%`) },
      order: { code: 'DESC' },
      withDeleted: true,
    });
    const newCode = CreateCode(prevOrder?.code ?? null, OrderPrefixCode, OrderDigitNumber);

    const order = this.orderRepository.create({
      userId: user.id,
      code: newCode,
      type: IOrderType.SSG,
      status: IOrderStatus.DELIVERY_REQUEST,
      eventName: `외부SSG주문`,
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

    const orderDelivery = this.orderDeliveryRepository.create({
      orderProductMappingId: mapping.id,
      status: IOrderDeliveryStatus.WAIT,
      deliveryMethod: IOrderSendMethod.ALIM_TALK,
      deliveryTarget: this.cryptoCipher.encryptDeliveryTarget(dto.recipientPhone),
      originalDeliveryTarget: this.cryptoCipher.encryptDeliveryTarget(dto.recipientPhone),
      sendRequestAt: new Date(),
      ssgEventId: ssgEvent.eventId,
    });
    await this.orderDeliveryRepository.save(orderDelivery);

    orderDelivery.transactionId = CreateApiTransactionId(order.id, orderDelivery.id);
    orderDelivery.externalTrId = await this.saveTransactionIds(orderDelivery.id, orderDelivery.transactionId);

    await this.ssgEventService.deductEventBalanceMultiple(ssgAllocations, order.id, false);

    mapping.product = product;
    mapping.order = order;
    order.user = user;
    orderDelivery.orderProductMapping = mapping;

    return { order, orderDelivery, mapping, product, ssgEvent };
  }

  // ─── 공통 유틸 ──────────────────────────────────────────

  private async findOrderDeliveryByTrId(account: ExternalApiAccountEntity, trId: string): Promise<OrderDeliveryEntity> {
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
    if (!order || order.userId !== account.user.id) {
      throw new ExternalApiException('4002', '주문에 대한 접근 권한 없음');
    }

    return orderDelivery;
  }

  /**
   * transactionId + externalTrId(ULID) 한 번에 저장. ULID unique 제약 위반 시 재생성 후 retry.
   */
  private async saveTransactionIds(
    orderDeliveryId: number,
    transactionId: string,
  ): Promise<string> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const externalTrId = ulid();
      try {
        await this.orderDeliveryRepository.update(orderDeliveryId, { transactionId, externalTrId });
        return externalTrId;
      } catch (error) {
        if (error?.code === 'ER_DUP_ENTRY' && attempt < 2) {
          this.logger.warn(`[saveTransactionIds] ULID 중복 발생, 재시도 (${attempt + 1}/3)`);
          continue;
        }
        throw error;
      }
    }
    throw new Error('externalTrId 생성 실패');
  }
}
