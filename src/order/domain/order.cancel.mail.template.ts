/** HTML 이메일 인젝션 방지 — 동적 값(이벤트명/사유 등 사용자 입력)은 삽입 전 이스케이프. */
const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const wrap = (title: string, bodyHtml: string): { title: string; content: string } => ({
  title,
  content: `
  <div style="max-width:560px;margin:0 auto;font-family:'Apple SD Gothic Neo',sans-serif;color:#222;line-height:1.7;">
    <h2 style="font-size:18px;">${title}</h2>
    ${bodyHtml}
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
    <p style="font-size:12px;color:#999;">이팝콘 프리미엄</p>
  </div>`,
});

export const orderCancelTemplate = (p: {
  personName: string;
  code: string;
  eventName: string;
  cancelReason: string | null;
  canceledAt: string;
}): { title: string; content: string } =>
  wrap(
    `주문이 취소되었습니다 (주문번호: ${p.code})`,
    `
    <p>${escapeHtml(p.personName || '고객')}님,</p>
    <p>아래 주문이 취소되었습니다.</p>
    <ul>
      <li>주문번호: ${escapeHtml(p.code)}</li>
      <li>이벤트명: ${escapeHtml(p.eventName)}</li>
      <li>취소사유: ${escapeHtml(p.cancelReason ?? '-')}</li>
      <li>취소일시: ${escapeHtml(p.canceledAt)}</li>
    </ul>
    <p>문의사항은 본 메일로 회신해 주시기 바랍니다.</p>`,
  );
