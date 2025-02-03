import { Module } from '@nestjs/common';
import { ISmsSend } from './interface/sms.send';
import { SmsGemtekSend } from './infra/sms.gemtek.send';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GemteckMsgQueueEntity } from '../entity/gemtek/msg.queue.entity';

@Module({
  imports: [TypeOrmModule.forFeature([GemteckMsgQueueEntity], 'gemtek_sms')],
  controllers: [],
  providers: [
    {
      provide: 'ISmsSend',
      useClass: SmsGemtekSend,
    },
  ],
  exports: [
    {
      provide: 'ISmsSend',
      useClass: SmsGemtekSend,
    },
    TypeOrmModule,
  ],
})
export class SmsModule {}
