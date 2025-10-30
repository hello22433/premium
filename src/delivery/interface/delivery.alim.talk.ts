import { InfoBankReportResponse, InfoBankSendResponse } from '../infra/delivery.alim.talk.info.bank.http';

export type IDeliveryAlimTalkSend = {
  to: string;
  text: string;
  encryptKey: string;
  templateCode?: string; // 선택적으로 템플릿 코드를 지정할 수 있음
};

export type IDeliveryAlimTalkSendOut = {
  responseData: InfoBankSendResponse;
  report: InfoBankReportResponse;
};

export interface DeliveryAlimTalk {
  send(sendObj: IDeliveryAlimTalkSend): Promise<IDeliveryAlimTalkSendOut>;
}
