import { Injectable, Logger } from '@nestjs/common';
import { format } from 'date-fns';
import { MailSendSmtp } from '../../mail/infrastructure/mail-send.smtp';
import { CompanyType } from '../../common/domain/company.type';
import { OrderEntity } from '../../entity/order.entity';
import { UserEntity } from '../../entity/user.entity';
import { orderCancelTemplate, orderPartialCancelTemplate } from '../domain/order.cancel.mail.template';

@Injectable()
export class OrderCancelNotificationService {
  private readonly logger = new Logger('ORDER_CANCEL_MAIL');

  constructor(private readonly mailSendSmtp: MailSendSmtp) {}

  async notifyDirectOrderCancel(order: OrderEntity, orderUser: UserEntity): Promise<void> {
    await this.send(order, orderUser, '취소', () =>
      orderCancelTemplate({
        personName: order.snapshotPersonName ?? orderUser.personName,
        code: order.code,
        eventName: order.eventName,
        cancelReason: order.cancelReason,
        canceledAt: order.canceledAt ? format(order.canceledAt, 'yyyy-MM-dd HH:mm:ss') : '',
      }),
    );
  }

  /**
   * 예약 발송건 부분취소 통지 (197-16).
   *
   * 부분취소는 order.cancelReason / canceledAt 을 채우지 않으므로(잔여분이 살아 있어 주문은
   * 발송확정 상태로 남는다) 사유·시각을 인자로 받는다.
   */
  async notifyDirectOrderPartialCancel(
    order: OrderEntity,
    orderUser: UserEntity,
    detail: { canceledCount: number; waitingCount: number; cancelReason: string; canceledAt: Date },
  ): Promise<void> {
    await this.send(order, orderUser, '부분취소', () =>
      orderPartialCancelTemplate({
        personName: order.snapshotPersonName ?? orderUser.personName,
        code: order.code,
        eventName: order.eventName,
        canceledCount: detail.canceledCount,
        waitingCount: detail.waitingCount,
        cancelReason: detail.cancelReason,
        canceledAt: format(detail.canceledAt, 'yyyy-MM-dd HH:mm:ss'),
      }),
    );
  }

  /** 수신자 확인 → 발송 → 실패 로깅. 통지 실패가 취소 자체를 되돌리면 안 되므로 예외는 삼킨다. */
  private async send(
    order: OrderEntity,
    orderUser: UserEntity,
    label: string,
    buildMail: () => { title: string; content: string },
  ): Promise<void> {
    try {
      const recipient = (orderUser.personEmail ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)[0];
      if (!recipient) {
        this.logger.warn(`order=${order.id} 대표 이메일 없음, ${label}메일 발송 skip`);
        return;
      }

      const companyType = order.snapshotDocumentCompanyType ?? orderUser.documentCompanyType ?? CompanyType.ENMAD;
      const { title, content } = buildMail();

      const result = await this.mailSendSmtp.send({ to: recipient, subject: title, content, companyType });
      if (!result.success) {
        this.logger.error(`order=${order.id} ${label}메일 발송 실패: ${result.error}`);
      }
    } catch (e: any) {
      this.logger.error(`order=${order.id} ${label}메일 처리 중 예외(무시): ${e?.message}`);
    }
  }
}
