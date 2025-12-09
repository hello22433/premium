export type EmailDeliveryTemplateIn = {
  topImagePath: string;
  productImagePath: string;
  text: string;
  url: string;
  code: string;
  useEmailContent: string;
  qrCodeImagePath?: string;
};

export function normalizeLineBreaks(text: string, replacement: string = '<br>'): string {
  const returnText = text
    .replaceAll(/\r\n/g, replacement) // Windows 줄바꿈 (\r\n)
    .replaceAll(/\r/g, replacement) // MacOS(구버전) 줄바꿈 (\r)
    .replaceAll(/\n/g, replacement) // Unix 줄바꿈 (\n)
    .replaceAll(/\\n/g, replacement); // Unix 줄바꿈 (\n)
  // .replaceAll(/<br\s*\/?>/gi, replacement); // HTML 줄바꿈 (<br>)
  return returnText;
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
          <img src="${obj.topImagePath}" width="382" height="125" alt="배너 이미지" style="display:block; border:none;" />
        </td>
      </tr>
      <tr>
        <!-- 2. 내용 -->
        <td style="padding:20px; font-size:14px; line-height:1.6; color:#333;">
         ${normalizeLineBreaks(obj.text, '<br>')}
        </td>
      </tr>
      <tr>
        <!-- 3. 상품 이미지와 사용방법 (같은 줄에 배치) -->
        <td style="padding:10px 20px;">
          <table style="width:100%; cellpadding=0; cellspacing=0; border=0;">
            <tr>
              <!-- 쿠폰 이미지 (왼쪽) -->
              <td style="width=200; valign=top; style=padding-right:15px;">
                <img src="${obj.productImagePath}" width="200" height="200" alt="상품 이미지" style="border-radius:8px; display:block;" />
              </td>
              <!-- 사용방법 (오른쪽) -->
              <td style="valign=top; font-size=13px; line-height=1.6; color=#555;">
                ${normalizeLineBreaks(obj.useEmailContent, '<br>')}
              </td>
            </tr>
          </table>
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
      ${obj.qrCodeImagePath ? `
      <tr>
        <!-- 7. QR 코드 -->
        <td align="center" style="padding:20px 0;">
          <img src="${obj.qrCodeImagePath}" alt="QR 코드" style="display:block; margin:0 auto;" />
        </td>
      </tr>
      ` : ''}
    </table>
</body>
</html>
`;
};
