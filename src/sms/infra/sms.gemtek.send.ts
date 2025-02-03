import { ISmsSend, SmsSendIn } from '../interface/sms.send';
import { GemteckMsgQueueEntity } from '../../entity/gemtek/msg.queue.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Logger } from '@nestjs/common';

export class SmsGemtekSend implements ISmsSend {
  constructor(
    // private configService: ConfigService,
    @InjectRepository(GemteckMsgQueueEntity, 'gemtek_sms')
    private gemteckMsgQueueRepository: Repository<GemteckMsgQueueEntity>,
  ) {}

  private logger = new Logger('SMS_GEMTEK');

  async send(obj: SmsSendIn): Promise<void> {
    const fileCnt = obj.filePath.length;

    if (fileCnt > 5) {
      throw new Error('There cannot be more than 5');
    }

    const fileLocations = Array(5)
      .fill(null)
      .map((_, index) => obj.filePath[index] ?? null);

    const [fileLoc1, fileLoc2, fileLoc3, fileLoc4, fileLoc5] = fileLocations;

    try {
      await this.gemteckMsgQueueRepository
        .createQueryBuilder('gemteckMsgQueue')
        .insert()
        .into('MSG_QUEUE')
        .values({
          msgType: obj.msgType,
          dstAddr: obj.to,
          callback: obj.from,
          subject: obj.subject,
          text: obj.text,
          requestTime: () => 'GETDATE()',
          fileLoc1,
          fileLoc2,
          fileLoc3,
          fileLoc4,
          fileLoc5,
          enmEtc02: 'epopkon-premium',
        })
        .execute();
      return;
    } catch (e) {
      this.logger.error(e);
      throw e;
    }
  }
}
