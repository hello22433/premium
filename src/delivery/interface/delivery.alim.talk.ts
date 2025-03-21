import { InfoBankReportResponse, InfoBankSendResponse } from '../infra/delivery.alim.talk.info.bank.http';

export type IDeliveryAlimTalkSend = {
  to: string;
  text: string;
  encryptKey: string;
};

export type IDeliveryAlimTalkSendOut = {
  responseData: InfoBankSendResponse;
  report: InfoBankReportResponse;
};

export interface DeliveryAlimTalk {
  send(sendObj: IDeliveryAlimTalkSend): Promise<IDeliveryAlimTalkSendOut>;
}
