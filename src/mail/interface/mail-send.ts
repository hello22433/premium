export interface IMailSendIn {
  to: string;
  cc: string | undefined;
  bcc: string | undefined;
  subject: string;
  content: string;
  saveSentMail: string;
  fromEmail?: string | null;
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
