import { Injectable, Logger } from '@nestjs/common';
import { format } from 'date-fns';
import { MailSendSmtp } from '../../mail/infrastructure/mail-send.smtp';
import { CompanyType } from '../../common/domain/company.type';
import { OrderEntity } from '../../entity/order.entity';
import { UserEntity } from '../../entity/user.entity';
import { orderCancelTemplate } from '../domain/order.cancel.mail.template';

@Injectable()
export class OrderCancelNotificationService {
  private readonly logger = new Logger('ORDER_CANCEL_MAIL');

  constructor(private readonly mailSendSmtp: MailSendSmtp) {}

  async notifyDirectOrderCancel(order: OrderEntity, orderUser: UserEntity): Promise<void> {
    try {
      const recipient = (orderUser.personEmail ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)[0];
      if (!recipient) {
        this.logger.warn(`order=${order.id} 대표 이메일 없음, 발송 skip`);
        return;
      }

      const companyType =
        order.snapshotDocumentCompanyType ?? orderUser.documentCompanyType ?? CompanyType.ENMAD;

      const { title, content } = orderCancelTemplate({
        personName: order.snapshotPersonName ?? orderUser.personName,
        code: order.code,
        eventName: order.eventName,
        cancelReason: order.cancelReason,
        canceledAt: order.canceledAt ? format(order.canceledAt, 'yyyy-MM-dd HH:mm:ss') : '',
      });

      const result = await this.mailSendSmtp.send({ to: recipient, subject: title, content, companyType });
      if (!result.success) {
        this.logger.error(`order=${order.id} 취소메일 발송 실패: ${result.error}`);
      }
    } catch (e: any) {
      this.logger.error(`order=${order.id} 취소메일 처리 중 예외(무시): ${e?.message}`);
    }
  }
}
