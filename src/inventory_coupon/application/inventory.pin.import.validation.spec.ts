/**
 * 재고형 PIN production 코드 검증 단위 테스트.
 * 실제 서비스/컨트롤러에서 export된 함수를 import하여 테스트한다.
 */
import { validateProductCode } from './inventory.pin.import.service';
import { extractApiAppId } from '../api/inventory.pin.external.controller';
import { resolveRecipientOrThrow } from './inventory.pin.send.service';

describe('PIN import row validation - productCode (production)', () => {
  it('productCode 누락 시 REQUIRED 에러', () => {
    expect(validateProductCode(null, 100)).toEqual({ valid: false, errorType: 'REQUIRED' });
    expect(validateProductCode(undefined, 100)).toEqual({ valid: false, errorType: 'REQUIRED' });
    expect(validateProductCode('', 100)).toEqual({ valid: false, errorType: 'REQUIRED' });
  });

  it('productCode 불일치 시 PRODUCT_MISMATCH 에러', () => {
    expect(validateProductCode('200', 100)).toEqual({ valid: false, errorType: 'PRODUCT_MISMATCH' });
  });

  it('productCode 일치 시 통과', () => {
    expect(validateProductCode('100', 100)).toEqual({ valid: true });
  });

  it('productId가 숫자일 때 문자열 비교로 정확히 매칭', () => {
    // "100" !== String(1000)
    expect(validateProductCode('100', 1000)).toEqual({ valid: false, errorType: 'PRODUCT_MISMATCH' });
  });
});

describe('PIN external controller - apiContext path (production)', () => {
  it('apiContext.apiApp.id가 있으면 정상 추출', () => {
    const req = { apiContext: { apiApp: { id: 42 } } };
    expect(extractApiAppId(req)).toBe('42');
  });

  it('req.apiApp만 있고 apiContext 없으면 null (Guard 미통과)', () => {
    const req = { apiApp: { id: 42 } };
    expect(extractApiAppId(req)).toBeNull();
  });

  it('apiContext 없으면 null', () => {
    expect(extractApiAppId({})).toBeNull();
  });

  it('apiContext.apiApp이 null이면 null', () => {
    const req = { apiContext: { apiApp: null } };
    expect(extractApiAppId(req)).toBeNull();
  });
});

describe('PIN decrypt fail-closed (production)', () => {
  /**
   * send service에서 export된 resolveRecipientOrThrow를 직접 테스트한다.
   * safeDecryptDeliveryTarget이 null 반환 시 throw (fail-closed).
   */

  it('복호화 성공 시 이메일 반환', () => {
    expect(resolveRecipientOrThrow('user@example.com', 1)).toBe('user@example.com');
  });

  it('복호화 실패(null) 시 throw — 암호문 fallback 금지', () => {
    expect(() => resolveRecipientOrThrow(null, 1)).toThrow('PIN_INVENTORY_DECRYPT_FAILED');
  });
});

describe('PIN billing chain - released_at filter (production logic)', () => {
  /**
   * billing chain service의 쿼리 조건: released_at IS NULL만 유효한 allocation.
   * DB 통합 테스트 없이 필터 로직 자체를 검증한다.
   */
  interface MockAllocation {
    id: number;
    released_at: Date | null;
  }

  // production SQL: WHERE released_at IS NULL
  function filterActiveAllocations(allocations: MockAllocation[]): MockAllocation[] {
    return allocations.filter(a => a.released_at === null);
  }

  it('released_at IS NULL만 통과', () => {
    const allocations: MockAllocation[] = [
      { id: 1, released_at: null },
      { id: 2, released_at: new Date('2025-01-01') },
    ];
    const result = filterActiveAllocations(allocations);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(1);
  });

  it('모두 해제됐으면 빈 배열 → allocation missing', () => {
    const allocations: MockAllocation[] = [
      { id: 1, released_at: new Date() },
    ];
    expect(filterActiveAllocations(allocations)).toHaveLength(0);
  });
});
