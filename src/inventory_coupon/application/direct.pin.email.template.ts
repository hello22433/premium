import { DirectPinEmailSnapshot } from '../domain/direct.pin.email.snapshot';

/**
 * 직접 PIN 이메일 서버 고정 레이아웃 렌더러. rev5 §8.1.
 * 기존 EmailDeliveryTemplate을 조건문으로 확장하지 않는다.
 *
 * PIN placeholder 없는 서버 렌더링 — raw HTML 삽입 금지, HTML escape 후 줄바꿈 렌더링.
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function formatAmount(amount: string, currencyCode: string): string {
  // ISO 통화 기반 포맷
  const num = parseFloat(amount);
  if (currencyCode === 'USD') return `$${num.toFixed(num % 1 === 0 ? 0 : 2)}`;
  if (currencyCode === 'KRW') return `₩${num.toLocaleString()}`;
  return `${currencyCode} ${num}`;
}

function textToHtml(text: string): string {
  return escapeHtml(text).replace(/\n/g, '<br/>');
}

export interface DirectPinRenderInput {
  snapshot: DirectPinEmailSnapshot;
  sendContent: string;
  productName: string;
  brandName: string;
  primaryCode: string;
  secondaryCode: string | null;
  validEndDate: string | null;
}

/**
 * 렌더링된 HTML을 반환한다. 렌더링 후 참조를 유지하지 않는다.
 */
export function renderDirectPinEmail(input: DirectPinRenderInput): string {
  const { snapshot, sendContent, productName, brandName, primaryCode, secondaryCode, validEndDate } = input;
  const formattedAmount = formatAmount(snapshot.faceValueAmount, snapshot.currencyCode);

  const secondaryBlock = secondaryCode && snapshot.secondaryCodeLabel
    ? `
      <tr>
        <td style="padding:8px 16px;color:#666;font-size:13px;">${escapeHtml(snapshot.secondaryCodeLabel)}</td>
      </tr>
      <tr>
        <td style="padding:4px 16px 16px;font-size:18px;font-weight:bold;font-family:monospace;letter-spacing:2px;word-break:break-all;">${escapeHtml(secondaryCode)}</td>
      </tr>`
    : '';

  const validEndBlock = validEndDate
    ? `<tr><td style="padding:8px 16px;color:#666;font-size:13px;">Valid until: ${escapeHtml(validEndDate)}</td></tr>`
    : '';

  return `<!DOCTYPE html>
<html lang="${snapshot.locale}">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#fff;">
  <tr><td style="padding:24px;text-align:center;background:#1a1a2e;color:#fff;font-size:20px;font-weight:bold;">${escapeHtml(brandName)}</td></tr>
  <tr><td style="padding:24px 16px;">
    ${textToHtml(sendContent)}
  </td></tr>
  <tr><td style="padding:8px 16px;font-size:15px;color:#333;">
    <strong>${escapeHtml(productName)}</strong> — ${formattedAmount}
  </td></tr>
  <tr><td style="padding:0 16px;"><hr style="border:none;border-top:1px solid #eee;"/></td></tr>
  <tr>
    <td style="padding:8px 16px;color:#666;font-size:13px;">${escapeHtml(snapshot.primaryCodeLabel)}</td>
  </tr>
  <tr>
    <td style="padding:4px 16px 16px;font-size:22px;font-weight:bold;font-family:monospace;letter-spacing:2px;word-break:break-all;color:#1a1a2e;">${escapeHtml(primaryCode)}</td>
  </tr>
  ${secondaryBlock}
  ${validEndBlock}
  <tr><td style="padding:0 16px;"><hr style="border:none;border-top:1px solid #eee;"/></td></tr>
  <tr><td style="padding:16px;font-size:13px;color:#666;">
    <strong>How to Use</strong><br/>${textToHtml(snapshot.howToUse)}
  </td></tr>
  <tr><td style="padding:0 16px 16px;font-size:12px;color:#999;">
    <strong>Notice</strong><br/>${textToHtml(snapshot.notice)}
  </td></tr>
</table>
</body>
</html>`;
}

/**
 * 테스트 발송용 샘플 렌더링. rev5 §8.4.
 * 실제 재고를 할당/복호화하지 않는다.
 */
export function renderSampleDirectPinEmail(input: Omit<DirectPinRenderInput, 'primaryCode' | 'secondaryCode'>): string {
  return renderDirectPinEmail({
    ...input,
    primaryCode: 'SAMPLE-PRIMARY-CODE',
    secondaryCode: input.snapshot.secondaryCodeLabel ? 'SAMPLE-SECONDARY-CODE' : null,
  });
}
