import { InfoBankReportResponse, InfoBankSendResponse } from '../infra/delivery.alim.talk.info.bank.http';

export type IDeliveryAlimTalkSend = {
  to: string;
  text: string;
  encryptKey?: string; // 쿠폰 발송 시 필수, 인증코드 등 버튼 불필요 시 생략
  templateCode?: string; // 선택적으로 템플릿 코드를 지정할 수 있음
  msgType?: 'AT' | 'AI'; // AT: 기본형, AI: 이미지 강조유형 (기본값: AI)
};

export type IDeliveryAlimTalkSendOut = {
  responseData: InfoBankSendResponse;
  report: InfoBankReportResponse;
};

export interface DeliveryAlimTalk {
  send(sendObj: IDeliveryAlimTalkSend): Promise<IDeliveryAlimTalkSendOut>;
}
