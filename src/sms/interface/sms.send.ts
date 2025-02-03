export interface SmsSendIn {
  msgType: 'S' | 'L' | 'M'; // SMS, LMS, MMS
  to: string; // 수신자 DSTADDR
  from: string; // 발신자 CALLBACK
  subject: string; // SUBJECT
  text: string; // TEXT
  filePath: string[]; // TODO 파일 업로드는 수정 필요
}

// export interface SmsSendOut {}

export interface ISmsSend {
  send(obj: SmsSendIn): Promise<void>;
}
