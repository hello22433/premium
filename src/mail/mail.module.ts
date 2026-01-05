import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { MailSendHiworks } from './infrastructure/mail-send.hiworks';
import { MailSendSmtp } from './infrastructure/mail-send.smtp';

@Module({
  imports: [HttpModule],
  controllers: [],
  providers: [
    {
      provide: 'IMailSend',
      useClass: MailSendHiworks,
    },
    MailSendSmtp,
  ],
  exports: [
    {
      provide: 'IMailSend',
      useClass: MailSendHiworks,
    },
    MailSendSmtp,
  ],
})
export class MailModule {}
