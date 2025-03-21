export interface SmsSendIn {
  msgType: 'S' | 'L' | 'M'; // SMS, LMS, MMS
  to: string; // 수신자 DSTADDR
  from: string; // 발신자 CALLBACK
  subject: string; // SUBJECT
  text: string; // TEXT
  filePath: string[];
}

// export interface SmsSendOut {}

export interface ISmsSend {
  send(obj: SmsSendIn): Promise<void>;
}
