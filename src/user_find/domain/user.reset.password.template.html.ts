export const userResetPasswordTemplate = (tempPassword: string) => {
  return {
    title: '모바일 E&M Ad 이팝콘 임시 비밀번호 전달:',
    content: `
      <h1 style="font-size: 30px; padding-right: 30px; padding-left: 30px; ">비밀번호 재설정</h1>
      <p style="font-size: 17px; padding-right: 30px; padding-left: 30px; ">
        
      </p>
      <div style="padding-right: 30px; padding-left: 30px; margin: 32px 0 40px;">
        <table style="border-collapse: collapse; border: 0; background-color: #F4F4F4; height: 70px; 
              table-layout: fixed; word-wrap: break-word; border-radius: 6px;">
          <tbody>
            <tr>
              <td style="text-align: center; vertical-align: middle; font-size: 30px;">
                ${tempPassword}
              </td>
            </tr>
          </tbody>
        </table>
      </div>`,
  };
};
