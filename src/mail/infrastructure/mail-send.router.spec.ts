import { MailSendRouter } from './mail-send.router';
import { MailSendHiworks } from './mail-send.hiworks';
import { MailSendSmtp, ISmtpMailSendOut } from './mail-send.smtp';
import { IMailSendIn, IMailSendOut } from '../interface/mail-send';

describe('MailSendRouter', () => {
  let router: MailSendRouter;
  let hiworks: jest.Mocked<MailSendHiworks>;
  let smtp: jest.Mocked<MailSendSmtp>;

  const baseInput: IMailSendIn = {
    to: 'customer@example.com',
    cc: undefined,
    bcc: undefined,
    subject: '쿠폰 발송',
    content: '<html>쿠폰</html>',
    saveSentMail: 'N',
  };

  beforeEach(() => {
    hiworks = {
      send: jest.fn(),
    } as unknown as jest.Mocked<MailSendHiworks>;

    smtp = {
      sendCouponEmail: jest.fn(),
      send: jest.fn(),
    } as unknown as jest.Mocked<MailSendSmtp>;

    router = new MailSendRouter(hiworks, smtp);
  });

  // ── 채널 선택 분기 ──

  it('@syscuss.com → SMTP 경로로 라우팅', async () => {
    smtp.sendCouponEmail.mockResolvedValue({ success: true, messageId: 'msg-1' });

    await router.send({ ...baseInput, fromEmail: 'service@syscuss.com' });

    expect(smtp.sendCouponEmail).toHaveBeenCalledTimes(1);
    expect(hiworks.send).not.toHaveBeenCalled();
  });

  it('@enmad.com → Hiworks 경로로 라우팅', async () => {
    const hiworksResult: IMailSendOut = {
      code: 'SUC',
      message: 'ok',
      result: { successList: ['customer@example.com'], dupList: [], wrongList: [] },
    };
    hiworks.send.mockResolvedValue(hiworksResult);

    const result = await router.send({ ...baseInput, fromEmail: 'service@enmad.com' });

    expect(hiworks.send).toHaveBeenCalledTimes(1);
    expect(smtp.sendCouponEmail).not.toHaveBeenCalled();
    expect(result.code).toBe('SUC');
  });

  it('fromEmail null → Hiworks 경로로 라우팅', async () => {
    const hiworksResult: IMailSendOut = {
      code: 'SUC',
      message: 'ok',
      result: { successList: ['customer@example.com'], dupList: [], wrongList: [] },
    };
    hiworks.send.mockResolvedValue(hiworksResult);

    await router.send({ ...baseInput, fromEmail: null });

    expect(hiworks.send).toHaveBeenCalledTimes(1);
    expect(smtp.sendCouponEmail).not.toHaveBeenCalled();
  });

  it('fromEmail 도메인 없음 (@ 없는 문자열) → Hiworks', async () => {
    hiworks.send.mockResolvedValue({
      code: 'SUC',
      message: 'ok',
      result: { successList: ['customer@example.com'], dupList: [], wrongList: [] },
    });

    await router.send({ ...baseInput, fromEmail: 'service' });

    expect(hiworks.send).toHaveBeenCalledTimes(1);
    expect(smtp.sendCouponEmail).not.toHaveBeenCalled();
  });

  // ── SMTP 성공 ──

  it('SMTP 성공 시 code=SUC 반환', async () => {
    smtp.sendCouponEmail.mockResolvedValue({ success: true, messageId: 'msg-123' });

    const result = await router.send({ ...baseInput, fromEmail: 'service@syscuss.com' });

    expect(result.code).toBe('SUC');
    expect(result.message).toContain('msg-123');
    expect(result.result.successList).toEqual(['customer@example.com']);
    expect(result.result.wrongList).toEqual([]);
  });

  // ── SMTP 실패 전파 (P1 수정 핵심) ──

  it('SMTP 실패 시 예외를 던져서 호출부 try/catch에 전파', async () => {
    smtp.sendCouponEmail.mockResolvedValue({
      success: false,
      error: 'SMTP auth failed: invalid credentials',
    });

    await expect(
      router.send({ ...baseInput, fromEmail: 'service@syscuss.com' }),
    ).rejects.toThrow('SMTP auth failed: invalid credentials');
  });

  it('SMTP 실패 시 error 없으면 기본 메시지로 예외', async () => {
    smtp.sendCouponEmail.mockResolvedValue({ success: false });

    await expect(
      router.send({ ...baseInput, fromEmail: 'service@syscuss.com' }),
    ).rejects.toThrow('SMTP 발송 실패');
  });

  it('SMTP sendCouponEmail 자체가 예외를 던지면 그대로 전파', async () => {
    smtp.sendCouponEmail.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      router.send({ ...baseInput, fromEmail: 'service@syscuss.com' }),
    ).rejects.toThrow('ECONNREFUSED');
  });

  // ── 대소문자 무시 ──

  it('@SYSCUSS.COM (대문자) → SMTP 경로', async () => {
    smtp.sendCouponEmail.mockResolvedValue({ success: true, messageId: 'msg-uc' });

    await router.send({ ...baseInput, fromEmail: 'service@SYSCUSS.COM' });

    expect(smtp.sendCouponEmail).toHaveBeenCalledTimes(1);
    expect(hiworks.send).not.toHaveBeenCalled();
  });
});
