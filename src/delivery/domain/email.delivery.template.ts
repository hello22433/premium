export type EmailDeliveryTemplateIn = {
  topImagePath: string;
  text: string;
  url: string;
  code: string;
  useEmailContent: string;
  qrCodeImagePath?: string;
};

function normalizeLineBreaks(text: string, replacement: string = '\n'): string {
  return text
    .replace(/\r\n/g, replacement) // Windows 줄바꿈 (\r\n)
    .replace(/\r/g, replacement) // MacOS(구버전) 줄바꿈 (\r)
    .replace(/\n/g, replacement) // Unix 줄바꿈 (\n)
    .replace(/<br\s*\/?>/gi, replacement); // HTML 줄바꿈 (<br>)
}

export const EmailDeliveryTemplate = (obj: EmailDeliveryTemplateIn) => {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset=“UTF-8">
  <meta name=“viewport” content=“width=device-width, initial-scale=1.0">
</head>
<body>
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff; max-width:400px; margin:0 auto; border:1px solid #ddd;">
      <tr>
        <!-- 1. 템플릿 배너 -->
        <td align="center" style="padding:0;">
          <!-- 
          
          -->
          <img src="https://www.epopkon.com/Resource/enmad_web/newpage/html/img/email-temp-test.jpg" width="382" height="125" alt="배너 이미지" style="display:block; border:none;" />
        </td>
      </tr>
      <tr>
        <!-- 2. 내용 -->
        <td style="padding:20px; font-size:14px; line-height:1.6; color:#333;">
         ${normalizeLineBreaks(obj.text, '<br>')}
        </td>
      </tr>
      <tr>
        <!-- 3. 상품 이미지 -->
        <td align="center" style="padding:10px;">
          <img src="${obj.topImagePath}" width="200" height="200" alt="상품 이미지" style="border-radius:8px;" />
        </td>
      </tr>
      <tr>
        <!-- 4. 사용방법 -->
        <td style="padding:10px 20px; font-size:13px; color:#555;">
          ${obj.useEmailContent}
        </td>
      </tr>
      <tr>
        <!-- 5. 인증 링크 -->
        <td align="center" style="padding:20px;">
          <a href="${obj.url}" target="_blank" style="background-color:#ff3b30; color:#fff; text-decoration:none; padding:10px 20px; border-radius:5px; display:inline-block; font-weight:bold;">
            쿠폰 인증하러 가기
          </a>
        </td>
      </tr>
      <tr>
        <!-- 6. 인증번호 -->
        <td align="center" style="padding:10px 0 20px 0; font-size:18px; font-weight:bold; color:#000;">
          인증번호: <span style="letter-spacing:2px;">${obj.code}</span>
        </td>
      </tr>
    </table>
    <img src="${obj.qrCodeImagePath}" alt=""></img>
</body>
</html>
`;
};
