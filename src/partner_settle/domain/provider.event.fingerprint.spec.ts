import { buildFingerprint, normalizeFingerprintParts } from './provider.event.fingerprint';

describe('normalizeFingerprintParts', () => {
  it('NULL·undefined·빈 문자열을 같은 sentinel 로 접는다', () => {
    // 접지 않으면 appNo 가 NULL 인 event 와 빈 문자열인 event 가 서로 다른 hash 로 갈려 dedup 이 깨진다.
    expect(normalizeFingerprintParts(['B1', null, 5000])).toBe('B1|-|5000');
    expect(normalizeFingerprintParts(['B1', undefined, 5000])).toBe('B1|-|5000');
    expect(normalizeFingerprintParts(['B1', '  ', 5000])).toBe('B1|-|5000');
  });

  it('앞뒤 공백만 다른 값은 같은 fingerprint 다', () => {
    expect(buildFingerprint([' B1 ', 'cpn'])).toBe(buildFingerprint(['B1', 'cpn']));
  });
});

describe('buildFingerprint', () => {
  it('version prefix 를 붙인다', () => {
    // 정규화 규칙을 바꾸면 과거 row 와 구별할 수 없어야 하므로 version 이 값 안에 있어야 한다.
    expect(buildFingerprint(['B1'])).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  it('필드 하나만 달라도 다른 값이 된다', () => {
    expect(buildFingerprint(['B1', '10', 5000])).not.toBe(buildFingerprint(['B1', '20', 5000]));
  });

  it('구분자 위치가 다른 조합을 같은 값으로 뭉개지 않는다', () => {
    // 'A|B' + 'C' 와 'A' + 'B|C' 가 같아지면 서로 다른 사건이 1 row 로 병합된다.
    expect(buildFingerprint(['A|B', 'C'])).not.toBe(buildFingerprint(['A', 'B|C']));
  });
});
