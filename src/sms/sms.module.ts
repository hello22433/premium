import { Module } from '@nestjs/common';
import { SmsGemtekSend } from './infra/sms.gemtek.send';
import { GemtekResultQuery } from './infra/gemtek.result.query';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GemteckMsgQueueEntity } from '../entity/gemtek/msg.queue.entity';

@Module({
  imports: [TypeOrmModule.forFeature([GemteckMsgQueueEntity], 'gemtek_sms')],
  controllers: [],
  providers: [
    SmsGemtekSend,
    GemtekResultQuery,
    {
      provide: 'ISmsSend',
      useClass: SmsGemtekSend,
    },
  ],
  exports: [
    SmsGemtekSend,
    GemtekResultQuery,
    {
      provide: 'ISmsSend',
      useClass: SmsGemtekSend,
    },
    TypeOrmModule,
  ],
})
export class SmsModule {}
