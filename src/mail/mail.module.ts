import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { MailSendHiworks } from './infrastructure/mail-send.hiworks';
import { MailSendSmtp } from './infrastructure/mail-send.smtp';
import { MailSendRouter } from './infrastructure/mail-send.router';

@Module({
  imports: [HttpModule.register({ timeout: 30000 })],
  controllers: [],
  providers: [
    MailSendHiworks,
    MailSendSmtp,
    {
      provide: 'IMailSend',
      useClass: MailSendRouter,
    },
  ],
  exports: [
    {
      provide: 'IMailSend',
      useClass: MailSendRouter,
    },
    MailSendSmtp,
  ],
})
export class MailModule {}
