export interface IMailSendIn {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  content: string;
  saveSentMail: string;
}

export interface IMailSendOut {
  code: string;
  message: string;
  result: {
    successList: string[];
    dupList: string[];
    wrongList: string[];
  };
}

export interface IMailSend {
  send(obj: IMailSendIn): Promise<IMailSendOut>;
}
