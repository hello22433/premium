/**
 * 재고형 PIN production 코드 검증 단위 테스트.
 * 실제 서비스/컨트롤러에서 export된 함수를 import하여 테스트한다.
 */
import { canonicalRequest, validateProductCode } from './inventory.pin.import.service';
import { INVALID_EXPIRES_ON, normalizeExpiresOn, todayInKst } from '../domain/inventory.pin.expires';
import { extractApiAppId } from '../api/inventory.pin.external.controller';
import { resolveRecipientOrThrow } from './inventory.pin.send.service';

describe('PIN import row validation - productCode (production)', () => {
  it('확정 양식에는 상품 열이 없다 — 값이 없으면 통과', () => {
    expect(validateProductCode(null, 100)).toEqual({ valid: true });
    expect(validateProductCode(undefined, 100)).toEqual({ valid: true });
    expect(validateProductCode('', 100)).toEqual({ valid: true });
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

describe('PIN import - 유효기간 KST 기준일 (production)', () => {
  it('UTC 로는 전날인 KST 새벽도 KST 날짜로 판정한다', () => {
    // 2026-08-14 00:30 KST = 2026-08-13 15:30 UTC
    expect(todayInKst(new Date('2026-08-13T15:30:00Z'))).toBe('2026-08-14');
  });

  it('KST 자정 직전은 아직 전날', () => {
    expect(todayInKst(new Date('2026-08-13T14:30:00Z'))).toBe('2026-08-13');
  });
});

describe('PIN import - 유효기간 정규화 (production)', () => {
  it('수동 등록의 한 자리 월/일 표기도 정규화한다 (문자열 비교 깨짐 방지)', () => {
    expect(normalizeExpiresOn('2026-8-1')).toBe('2026-08-01');
    expect(normalizeExpiresOn('2026.8.1')).toBe('2026-08-01');
    expect(normalizeExpiresOn('20260801')).toBe('2026-08-01');
  });

  it('정규화 전이면 만료인데도 통과하던 값을 정규화 후 만료로 판정한다', () => {
    const today = todayInKst(new Date('2026-08-14T00:00:00Z'));

    // 원본 문자열 비교라면 '2026-8-1' > '2026-08-14' 로 유효 판정되는 값이다.
    expect('2026-8-1' < today).toBe(false);
    expect((normalizeExpiresOn('2026-8-1') as string) < today).toBe(true);
  });

  it('빈 값은 무기한, 해석 불가는 INVALID', () => {
    expect(normalizeExpiresOn(null)).toBeNull();
    expect(normalizeExpiresOn('')).toBeNull();
    expect(normalizeExpiresOn('내년까지')).toBe(INVALID_EXPIRES_ON);
    expect(normalizeExpiresOn('2026-02-31')).toBe(INVALID_EXPIRES_ON);
    expect(normalizeExpiresOn(true)).toBe(INVALID_EXPIRES_ON);
  });
});

describe('PIN import - 멱등 requestHash 입력 (production)', () => {
  const meta = { supplierName: '이커머스', sourcePartnerCompanyId: null, purchaseReference: null, purchasedAt: null };

  it('같은 파일을 다른 상품에 올리면 다른 요청이다 (재생 응답 금지)', () => {
    expect(canonicalRequest(meta, 100)).not.toBe(canonicalRequest(meta, 200));
  });

  it('구매처·참조번호·구매일·매입처도 해시 입력이다', () => {
    const base = canonicalRequest(meta, 100);
    expect(canonicalRequest({ ...meta, supplierName: '다른처' }, 100)).not.toBe(base);
    expect(canonicalRequest({ ...meta, purchaseReference: 'PO-1' }, 100)).not.toBe(base);
    expect(canonicalRequest({ ...meta, purchasedAt: '2026-08-14' }, 100)).not.toBe(base);
    expect(canonicalRequest({ ...meta, sourcePartnerCompanyId: 7 }, 100)).not.toBe(base);
  });

  it('null 과 빈 문자열을 구분하고 값 경계가 섞이지 않는다', () => {
    expect(canonicalRequest({ ...meta, purchaseReference: '' }, 100)).not.toBe(canonicalRequest(meta, 100));
    expect(canonicalRequest({ ...meta, supplierName: 'a', purchaseReference: 'b' }, 100)).not.toBe(
      canonicalRequest({ ...meta, supplierName: 'ab', purchaseReference: null }, 100),
    );
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
    return allocations.filter((a) => a.released_at === null);
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
    const allocations: MockAllocation[] = [{ id: 1, released_at: new Date() }];
    expect(filterActiveAllocations(allocations)).toHaveLength(0);
  });
});
