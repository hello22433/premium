import { Injectable, Logger } from '@nestjs/common';
import { IMailSend, IMailSendIn, IMailSendOut } from '../interface/mail-send';
import { MailSendHiworks } from './mail-send.hiworks';
import { MailSendSmtp } from './mail-send.smtp';
import { CompanyType } from '../../common/domain/company.type';

/**
 * fromEmail 도메인에 따라 Hiworks / SMTP를 분기하는 메일 발송 라우터.
 *
 * 분기 규칙:
 * - `@syscuss.com` → SMTP (CompanyType.SYSCUSS)
 * - `@enmad.com` / 도메인 없음 / null → Hiworks (기존 동작)
 *
 * SMTP 경로에서의 어댑터 처리:
 * - BCC 차단: 쿠폰 메일에 BCC가 붙으면 안 됨 (개인정보 이슈)
 * - HTML <br> 주입 차단: 쿠폰 메일 본문은 이미 HTML
 * - 반환값 변환: ISmtpMailSendOut → IMailSendOut
 */
@Injectable()
export class MailSendRouter implements IMailSend {
  private readonly logger = new Logger('MAIL_ROUTER');

  constructor(
    private readonly hiworks: MailSendHiworks,
    private readonly smtp: MailSendSmtp,
  ) {}

  async send(obj: IMailSendIn): Promise<IMailSendOut> {
    const domain = this.extractDomain(obj.fromEmail);

    if (domain === 'syscuss.com') {
      return this.sendViaSmtp(obj);
    }

    // enmad.com / 도메인 없음 / null → Hiworks (기존 동작)
    return this.hiworks.send(obj);
  }

  /**
   * SMTP 경로: BCC 차단 + HTML 보존 + 반환값 변환
   */
  private async sendViaSmtp(obj: IMailSendIn): Promise<IMailSendOut> {
    const smtpResult = await this.smtp.sendCouponEmail({
      to: obj.to,
      cc: obj.cc,
      subject: obj.subject,
      content: obj.content,
      attachments: obj.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType,
      })),
      companyType: CompanyType.SYSCUSS,
    });

    // ISmtpMailSendOut → IMailSendOut 변환
    if (!smtpResult.success) {
      // Hiworks 어댑터와 동일하게 예외를 던져야 호출부(try/catch)가 실패를 감지한다.
      throw new Error(smtpResult.error || 'SMTP 발송 실패');
    }

    return {
      code: 'SUC',
      message: `SMTP 발송 성공: ${smtpResult.messageId}`,
      result: {
        successList: [obj.to],
        dupList: [],
        wrongList: [],
      },
    };
  }

  /**
   * fromEmail에서 도메인 추출.
   * 'service' → null (도메인 없음)
   * 'service@enmad.com' → 'enmad.com'
   * null/undefined → null
   */
  private extractDomain(fromEmail: string | null | undefined): string | null {
    if (!fromEmail) return null;
    const atIndex = fromEmail.indexOf('@');
    if (atIndex < 0) return null;
    return fromEmail.substring(atIndex + 1).toLowerCase();
  }
}
