/**
 * 휴면(NOT_USED) 계정 재활성화 본인인증 이메일 템플릿.
 * 로그인 인증 메일(userLoginTemplateHtml)과 분리하여 "휴면 해제" 맥락을 명확히 전달한다.
 */
export const userReactivateTemplateHtml = (code: string, expireMinute: number) => {
  return {
    title: '[이팝콘 프리미엄] 휴면 계정 재활성화 인증코드',
    content: `
      <div style="max-width:520px; margin:0 auto; padding:40px 0; font-family:'Apple SD Gothic Neo',-apple-system,'Malgun Gothic',sans-serif; color:#333;">
        <h1 style="font-size:26px; margin:0 0 8px; padding:0 30px;">휴면 계정 재활성화</h1>
        <p style="font-size:15px; line-height:1.7; color:#555; padding:0 30px; margin:0 0 4px;">
          장기 미사용으로 <b>휴면(중지)</b> 상태인 계정의 본인인증 요청입니다.
        </p>
        <p style="font-size:15px; line-height:1.7; color:#555; padding:0 30px; margin:0 0 24px;">
          아래 인증코드를 유효시간 <b>${expireMinute}분</b> 안에 입력하면 계정이 다시 활성화됩니다.
        </p>
        <div style="padding:0 30px; margin:0 0 28px;">
          <table role="presentation" style="border-collapse:collapse; width:100%; background-color:#F4F4F4; height:72px; border-radius:6px; table-layout:fixed; word-wrap:break-word;">
            <tbody>
              <tr>
                <td style="text-align:center; vertical-align:middle; font-size:32px; letter-spacing:8px; font-weight:700; color:#222;">
                  ${code}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p style="font-size:13px; line-height:1.7; color:#999; padding:0 30px; margin:0;">
          본인이 요청하지 않았다면 이 메일을 무시하셔도 됩니다.<br />
          재활성화 후에는 로그인 화면에서 다시 로그인해주세요.
        </p>
      </div>`,
  };
};
