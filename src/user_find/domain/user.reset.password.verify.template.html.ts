export const UserResetPasswordVerifyTemplateHtml = (code: string, expireMinute: number) => {
  return {
    title: '모바일 E&M Ad 이팝콘 임시 비밀번호 인증코드 발송',
    content: `
      <h1 style="font-size: 30px; padding-right: 30px; padding-left: 30px; ">로그인 확인</h1>
      <p style="font-size: 17px; padding-right: 30px; padding-left: 30px; ">
        아래 확인 코드를 유효시간 ${expireMinute}분 안에 로그인 화면에서 입력해주세요.
      </p>
      <div style="padding-right: 30px; padding-left: 30px; margin: 32px 0 40px;">
        <table style="border-collapse: collapse; border: 0; background-color: #F4F4F4; height: 70px; 
              table-layout: fixed; word-wrap: break-word; border-radius: 6px;">
          <tbody>
            <tr>
              <td style="text-align: center; vertical-align: middle; font-size: 30px;">
                ${code}
              </td>
            </tr>
          </tbody>
        </table>
      </div>`,
  };
};
