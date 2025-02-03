import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { MailSendHiworks } from './infrastructure/mail-send.hiworks';

@Module({
  imports: [HttpModule],
  controllers: [],
  providers: [
    {
      provide: 'IMailSend',
      useClass: MailSendHiworks,
    },
  ],
  exports: [
    {
      provide: 'IMailSend',
      useClass: MailSendHiworks,
    },
  ],
})
export class MailModule {}
