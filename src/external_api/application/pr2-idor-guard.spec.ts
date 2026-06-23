import * as fs from 'fs';
import * as path from 'path';

/**
 * PR2 매핑모드 IDOR 5축 회귀 가드 (ralplan PR2 Phase 3.7/3.8, HIGH-3).
 *
 * 매핑모드에서 order.clientUserId = 매핑 billingUserId 가 적재되므로, clientUserId/clientUser 를
 * 가시성 축으로 쓰는 내부 포털/통계/CS 쿼리는 외부 매핑주문(apiAppId IS NOT NULL)을 노출하면 안 된다.
 * 모든 가시성 축에 `apiAppId IS NULL` 가드가 붙어 외부 매핑주문을 격리하는지 정적 검증한다.
 * (settle 정산귀속 축은 유지 대상이므로 검증 대상 아님.)
 */
describe('PR2 IDOR 5축 가시성 가드 — 구조 검증', () => {
  const root = path.resolve(__dirname, '../../..');
  const orderServiceSrc = fs.readFileSync(
    path.join(root, 'src/order/application/order.service.ts'),
    'utf8',
  );
  const csServiceSrc = fs.readFileSync(
    path.join(root, 'src/customer_service/application/customer.service.service.ts'),
    'utf8',
  );

  // 공백 무시 비교용 정규화
  const norm = (s: string) => s.replace(/\s+/g, ' ');
  const orderN = norm(orderServiceSrc);
  const csN = norm(csServiceSrc);

  it('order.service applyUserOrderFilter(SELF view-scope) clientUserId 축에 apiAppId IS NULL 가드', () => {
    expect(orderN).toContain('(order.clientUserId = :userId AND order.apiAppId IS NULL)');
    // 가드 없는 옛 형태가 남아있지 않아야 한다
    expect(orderN).not.toContain('OR order.clientUserId = :userId)');
  });

  it('order.service applyDirectSendingFilter(CORPORATE_ADMIN list/detail) clientUserId 축에 가드', () => {
    expect(orderN).toContain(
      '(order.clientUserId IS NULL OR (order.clientUserId = :currentUserId AND order.apiAppId IS NULL))',
    );
    expect(orderN).not.toContain('(order.clientUserId IS NULL OR order.clientUserId = :currentUserId)');
  });

  it('order.service getDashboard(CORPORATE_ADMIN 통계) clientUserId 축에 가드', () => {
    expect(orderN).toContain('(o.userId = :uid OR (o.clientUserId = :uid AND o.apiAppId IS NULL))');
    expect(orderN).not.toContain('(o.userId = :uid OR o.clientUserId = :uid)');
  });

  it('customer.service CS 목록/엑셀 clientUser.companyId 축에 order.apiAppId IS NULL 가드(2곳)', () => {
    const guarded =
      '(user.companyId = :userCompanyId OR (clientUser.companyId = :userCompanyId AND order.apiAppId IS NULL))';
    // 정규화 본문에 가드 형태가 2회 등장(목록 + 엑셀)
    const occurrences = csN.split(guarded).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
    // 가드 없는 옛 형태 부재
    expect(csN).not.toContain('(user.companyId = :userCompanyId OR clientUser.companyId = :userCompanyId)');
  });

  it('OPERATION_ADMIN 축은 operationUserId 기준이라 수정 대상 아님(외부 operationUserId=null로 안전)', () => {
    // direct-sending OPERATION_ADMIN 분기는 그대로 유지
    expect(orderN).toContain('(order.clientUserId IS NULL OR order.operationUserId = :currentUserId)');
    // dashboard OPERATION_ADMIN 분기도 operationUserId 기준 유지
    expect(orderN).toContain('(o.userId = :uid OR o.operationUserId = :uid)');
  });
});
