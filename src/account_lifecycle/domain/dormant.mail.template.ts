/**
 * 휴면/탈퇴 라이프사이클 단계별 통보메일 템플릿.
 * 단계: 중지(NOT_USED) / 탈퇴(LEAVE, 파기예정 고지) / 파기직전(익명화).
 */

/** HTML 이메일 인젝션 방지 — 동적 값(personName 등 사용자 입력)은 삽입 전 이스케이프. */
const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const wrap = (title: string, bodyHtml: string): { title: string; content: string } => ({
  title,
  content: `
  <div style="max-width:560px;margin:0 auto;font-family:'Apple SD Gothic Neo',sans-serif;color:#222;line-height:1.7;">
    <h2 style="font-size:18px;">${title}</h2>
    ${bodyHtml}
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
    <p style="font-size:12px;color:#999;">본 메일은 발신전용입니다. 이팝콘 프리미엄.</p>
  </div>`,
});

/** 1단계: 3개월 미활동 → 휴면(중지) 전환 안내. */
export const dormantSuspendTemplate = (personName: string): { title: string; content: string } =>
  wrap('[이팝콘 프리미엄] 계정이 휴면 상태로 전환되었습니다', `
    <p>${escapeHtml(personName || '고객')}님,</p>
    <p>최근 3개월간 로그인 및 서비스 이용 내역이 없어 계정이 <b>휴면(중지)</b> 상태로 전환되었습니다.</p>
    <p>다시 이용하시려면 로그인 화면에서 <b>이메일 본인인증을 통한 재활성화</b>를 진행해주세요.</p>
    <p>휴면 상태가 <b>6개월</b> 더 지속되면 계정은 탈퇴 처리되며, 이후 6개월 뒤 개인정보가 파기됩니다.</p>
  `);

/** 2단계: 휴면 6개월 경과 → 탈퇴(LEAVE) 전환 + 6개월 후 파기 예정 고지. */
export const dormantWithdrawTemplate = (personName: string): { title: string; content: string } =>
  wrap('[이팝콘 프리미엄] 장기 휴면으로 계정이 탈퇴 처리되었습니다', `
    <p>${escapeHtml(personName || '고객')}님,</p>
    <p>휴면 상태가 6개월 이상 지속되어 계정이 <b>탈퇴</b> 처리되었습니다.</p>
    <p>탈퇴된 계정은 재활성화할 수 없으며, 재이용을 원하시면 신규 가입이 필요합니다.</p>
    <p><b>6개월 후 회원님의 개인정보는 관련 법령에 따라 파기(익명화)</b>될 예정입니다. 거래 이력 등 보존 의무가 있는 기록은 법정 기간 동안 보관됩니다.</p>
  `);

/** 3단계: 탈퇴 6개월 경과 → 개인정보 파기(익명화) 직전 최종 고지. */
export const dormantDeleteTemplate = (personName: string): { title: string; content: string } =>
  wrap('[이팝콘 프리미엄] 개인정보 파기 안내', `
    <p>${escapeHtml(personName || '고객')}님,</p>
    <p>탈퇴 후 6개월이 경과하여 회원님의 <b>개인정보를 파기(익명화)</b>합니다.</p>
    <p>이메일·연락처 등 개인식별정보는 즉시 마스킹되며, 본 메일 이후 발송되는 안내는 없습니다.</p>
    <p>그동안 이팝콘 프리미엄을 이용해주셔서 감사합니다.</p>
  `);
