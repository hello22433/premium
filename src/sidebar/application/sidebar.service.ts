import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { subDays } from 'date-fns';
import { OrderEntity } from '../../entity/order.entity';
import { OrderReceiptEntity } from '../../entity/order.receipt.entity';
import { QnaEntity } from '../../entity/qna.entity';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { IUserAuthority } from '../../user/interface/user.authority';
import { IOrderStatus } from '../../order/interface/order.status';
import { IOrderType } from '../../order/interface/order.type';
import { OrderReceiptStatus } from '../../order_receipt/interface/order.receipt.status';
import { IQnaStatus } from '../../qna/interface/qna.status';
import { SidebarNotificationsResDto } from '../api/sidebar.res.dto';

@Injectable()
export class SidebarService {
  constructor(
    @InjectRepository(OrderEntity)
    private orderRepository: Repository<OrderEntity>,

    @InjectRepository(OrderReceiptEntity)
    private orderReceiptRepository: Repository<OrderReceiptEntity>,

    @InjectRepository(QnaEntity)
    private qnaRepository: Repository<QnaEntity>,
  ) {}

  async getNotificationCounts(user: ILoginUserInfo): Promise<SidebarNotificationsResDto> {
    const [orderCounts, orderReceiptCount, qnaWaitCount] = await Promise.all([
      this.getOrderCounts(user),
      this.getOrderReceiptCount(user),
      this.getQnaWaitCount(user),
    ]);

    return { ...orderCounts, orderReceiptCount, qnaWaitCount };
  }

  /**
   * 주문 카운트 (DELIVERY_REQUEST 상태, GENERAL/SSG 타입별 조건부 집계)
   * 권한 패턴 참조: order.service.ts getMyOrderHistory() - switch(user.authority)
   */
  private async getOrderCounts(user: ILoginUserInfo): Promise<{ generalCouponCount: number; ssgCount: number }> {
    const qb = this.orderRepository
      .createQueryBuilder('o')
      .select('SUM(CASE WHEN o.type = :general THEN 1 ELSE 0 END)', 'generalCouponCount')
      .addSelect('SUM(CASE WHEN o.type = :ssg THEN 1 ELSE 0 END)', 'ssgCount')
      .where('o.status = :status', { status: IOrderStatus.DELIVERY_REQUEST })
      .setParameter('general', IOrderType.GENERAL)
      .setParameter('ssg', IOrderType.SSG);

    switch (user.authority as IUserAuthority) {
      case IUserAuthority.SUPER_ADMIN:
        break;

      case IUserAuthority.OPERATION_ADMIN:
        qb.andWhere('(o.userId = :uid OR o.operationUserId = :uid)', { uid: user.id });
        break;

      case IUserAuthority.CORPORATE_ADMIN:
      default:
        qb.andWhere('(o.userId = :uid OR o.clientUserId = :uid)', { uid: user.id });
        break;
    }

    const raw = await qb.getRawOne<Record<string, string>>();
    return {
      generalCouponCount: Number(raw?.generalCouponCount) || 0,
      ssgCount: Number(raw?.ssgCount) || 0,
    };
  }

  /**
   * 주문접수 카운트 (RECEIVED 상태)
   * 권한 패턴 참조: order.receipt.service.ts getList() - CORPORATE_ADMIN userId + 180일 필터
   */
  private async getOrderReceiptCount(user: ILoginUserInfo): Promise<number> {
    const qb = this.orderReceiptRepository
      .createQueryBuilder('orderReceipt')
      .where('orderReceipt.status = :status', { status: OrderReceiptStatus.RECEIVED });

    if (user.authority === IUserAuthority.CORPORATE_ADMIN) {
      const dateLimit = subDays(new Date(), 180);
      qb.andWhere('orderReceipt.userId = :userId', { userId: user.id })
        .andWhere('orderReceipt.registerAt >= :dateLimit', { dateLimit });
    }

    return qb.getCount();
  }

  /**
   * 1:1문의(QnA) 답변대기 카운트 (WAIT 상태)
   * 권한 패턴 참조: qna.service.ts getMyQnaHistory() + getList()
   */
  private async getQnaWaitCount(user: ILoginUserInfo): Promise<number> {
    const qb = this.qnaRepository
      .createQueryBuilder('qna')
      .where('qna.status = :status', { status: IQnaStatus.WAIT });

    if (user.authority === IUserAuthority.CORPORATE_ADMIN) {
      qb.andWhere('qna.userId = :userId', { userId: user.id });
    }

    return qb.getCount();
  }
}
