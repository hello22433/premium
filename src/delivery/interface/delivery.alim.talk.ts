import {
  InfoBankInquiryResult,
  InfoBankReportResponse,
  InfoBankSendResponse,
} from '../infra/delivery.alim.talk.info.bank.http';

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
  // 발송 배치 비동기 경로: POST 만 수행하고 msgKey 반환 (수신확인은 reportSweep 위임)
  postAlimtalk(sendObj: IDeliveryAlimTalkSend): Promise<{ msgKey: string; responseData: InfoBankSendResponse }>;
  // reportSweep 가 호출하는 수신리포트 단건 조회
  inquiryReport(msgKey: string): Promise<InfoBankInquiryResult>;
}
