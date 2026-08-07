import { Inject, Injectable, Logger } from '@nestjs/common';
import { IMailSend, IMailSendIn, IMailSendOut } from '../../mail/interface/mail-send';

/**
 * 직접 PIN 전용 메일 발송 래퍼. rev5 §5.4.
 *
 * - saveSentMail='N' 강제
 * - body/error/tracing 캡처 비활성화 (allowlist redacted outcome만)
 * - EmailSendHistory/URL/QR 미사용
 * - 단일 recipient가 successList에 있을 때만 SENT
 */
@Injectable()
export class DirectPinMailSender {
  private readonly logger = new Logger(DirectPinMailSender.name);

  constructor(
    @Inject('IMailSend')
    private readonly mailSend: IMailSend,
  ) {}

  /**
   * 직접 PIN 이메일 발송.
   * @returns 성공/실패/오류코드. PIN 원문은 결과에 포함하지 않는다.
   */
  async send(params: DirectPinMailParams): Promise<DirectPinMailResult> {
    const mailInput: IMailSendIn = {
      to: params.recipientEmail,
      cc: undefined,
      bcc: undefined,
      subject: params.subject,
      content: params.htmlBody,
      saveSentMail: 'N', // 강제 — 발신함 저장 금지
      fromEmail: params.fromEmail,
    };

    try {
      const result: IMailSendOut = await this.mailSend.send(mailInput);

      // 성공 판정: 단일 recipient가 successList에 포함
      if (result.result?.successList?.includes(params.recipientEmail)) {
        return { outcome: 'SENT', providerCode: result.code };
      }

      // wrongList 또는 dupList에 있거나 successList에 없으면 FAILED
      const errorCode = this.redactErrorCode(result.code, result.message);
      this.logger.warn(`DirectPinMail: recipient not in successList, code=${errorCode}`);
      return { outcome: 'FAILED', providerCode: result.code, errorCode };
    } catch (err: any) {
      // timeout/throw → UNKNOWN 또는 FAILED
      const errorCode = this.redactErrorCode(err?.code, err?.message);
      // 에러 로그에 PIN/recipient/body를 남기지 않는다
      this.logger.error(`DirectPinMail: provider error, code=${errorCode}`);
      return { outcome: 'UNKNOWN', errorCode };
    }
  }

  /**
   * 허용된 코드만 정규화. provider가 body/PIN을 echo하면 저장하지 않는다.
   */
  private redactErrorCode(code?: string, message?: string): string {
    const ALLOWED_CODES = ['001', '002', '003', '100', '200', '400', '500', 'TIMEOUT', 'CONNECTION_ERROR'];
    if (code && ALLOWED_CODES.includes(code)) return code;
    return 'PROVIDER_ERROR';
  }
}

export interface DirectPinMailParams {
  recipientEmail: string;
  subject: string;
  htmlBody: string;
  fromEmail: string;
}

export interface DirectPinMailResult {
  outcome: 'SENT' | 'FAILED' | 'UNKNOWN';
  providerCode?: string;
  errorCode?: string;
}
