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

/**
 * 예약 발송건 부분취소 통지 (197-16).
 *
 * ★ orderCancelTemplate 을 재사용하면 안 된다. 그쪽 문구는 "주문이 취소되었습니다" 라
 *   잔여분이 예정대로 나가는 부분취소에 쓰면 고객에게 거짓을 알리게 된다.
 *   취소된 건수와 남은 건수를 함께 적어 무엇이 어떻게 됐는지 오해 없이 전달한다.
 */
export const orderPartialCancelTemplate = (p: {
  personName: string;
  code: string;
  eventName: string;
  canceledCount: number;
  waitingCount: number;
  cancelReason: string | null;
  canceledAt: string;
}): { title: string; content: string } =>
  wrap(
    `예약 발송 건이 일부 취소되었습니다 (주문번호: ${p.code})`,
    `
    <p>${escapeHtml(p.personName || '고객')}님,</p>
    <p>아래 주문의 <strong>발송 대기 건 중 일부</strong>가 취소되었습니다. 남은 건은 예정대로 발송됩니다.</p>
    <ul>
      <li>주문번호: ${escapeHtml(p.code)}</li>
      <li>이벤트명: ${escapeHtml(p.eventName)}</li>
      <li>취소된 발송 건수: ${p.canceledCount}건</li>
      <li>앞으로 발송될 건수: ${p.waitingCount}건</li>
      <li>취소사유: ${escapeHtml(p.cancelReason ?? '-')}</li>
      <li>취소일시: ${escapeHtml(p.canceledAt)}</li>
    </ul>
    <p>취소된 건의 금액은 예치금 또는 여신으로 복구됩니다.</p>
    <p>문의사항은 본 메일로 회신해 주시기 바랍니다.</p>`,
  );

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
