export type EmailDeliveryTemplateIn = {
  topImagePath: string;
  text: string;
  url: string;
  code: string;
  useEmailContent: string;
  qrCodeImagePath?: string;
};

export const EmailDeliveryTemplate = (obj: EmailDeliveryTemplateIn) => {
  return `
<!DOCTYPE html>
<html >
<head>
  <meta charset=“UTF-8">
  <meta name=“viewport” content=“width=device-width, initial-scale=1.0">
</head>
<body>
  <div class="">
    <img src="${obj.topImagePath}" alt=""></img>
    <p>${obj.text}</p>
    <p>사용 방법 : ${obj.useEmailContent}</p>
    <p>링크 : ${obj.url}</p>
    <p>인증 번호 : ${obj.code}</p>
    <img src="${obj.qrCodeImagePath}" alt=""></img>
  </div>
</body>
</html>
`;
};
