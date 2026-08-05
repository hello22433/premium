import {
  ConfigVersionConflictError,
  decideConfigMutation,
} from './credit.config.decision';

describe('decideConfigMutation (정본 §5.3 optimistic lock)', () => {
  it('row 없음 + expectedVersion=null → CREATE', () => {
    expect(decideConfigMutation(null, null)).toEqual({ kind: 'CREATE' });
  });

  it('row 없음 + expectedVersion 있음 → 충돌', () => {
    expect(() => decideConfigMutation(null, 0)).toThrow(ConfigVersionConflictError);
    expect(() => decideConfigMutation(null, 3)).toThrow(ConfigVersionConflictError);
  });

  it('row 있음 + version 일치 → UPDATE(version+1)', () => {
    expect(decideConfigMutation(0, 0)).toEqual({ kind: 'UPDATE', nextVersion: 1 });
    expect(decideConfigMutation(7, 7)).toEqual({ kind: 'UPDATE', nextVersion: 8 });
  });

  it('row 있음 + expectedVersion=null → 충돌(최초 생성 기대인데 이미 존재)', () => {
    expect(() => decideConfigMutation(0, null)).toThrow(ConfigVersionConflictError);
  });

  it('row 있음 + version 불일치(stale) → 충돌', () => {
    expect(() => decideConfigMutation(5, 4)).toThrow(ConfigVersionConflictError);
    expect(() => decideConfigMutation(5, 6)).toThrow(ConfigVersionConflictError);
  });
});
