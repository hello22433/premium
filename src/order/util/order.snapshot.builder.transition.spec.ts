import { buildClientAssignmentTransition } from './order.snapshot.builder';
import { UserEntity } from '../../entity/user.entity';

const clientUser = {
  id: 10,
  personName: '윤혜진',
  personPhoneNumber: '010-0000-0000',
  email: 'client@test.com',
  settleCondition: 'CONDITION',
  documentCompanyType: 'TYPE',
  company: {
    businessName: '(주)밀텍산업',
    businessNumber: 'biz-no',
    businessAddress: 'addr',
    industryType: 'it',
    industryItem: 'ii',
  },
} as unknown as UserEntity;

const operationUser = { id: 3, personName: '관리자' } as unknown as UserEntity;

describe('buildClientAssignmentTransition', () => {
  it('고객사 변경 없음(동일 id) → null 반환(스냅샷 유지)', () => {
    expect(
      buildClientAssignmentTransition({
        previousClientUserId: 10,
        nextClientUserId: 10,
        nextClientUser: clientUser,
        operationUser,
      }),
    ).toBeNull();
  });

  it('레거시 유지(이전·이후 모두 null) → null 반환(자동 보정 안 함)', () => {
    expect(
      buildClientAssignmentTransition({
        previousClientUserId: null,
        nextClientUserId: null,
        nextClientUser: null,
        operationUser: null,
      }),
    ).toBeNull();
  });

  it('고객사 신규 지정 → client 스냅샷 재작성 + operation 자동 배정', () => {
    const patch = buildClientAssignmentTransition({
      previousClientUserId: null,
      nextClientUserId: 10,
      nextClientUser: clientUser,
      operationUser,
    });

    expect(patch).toMatchObject({
      operationUserId: 3,
      snapshotClientPersonName: '윤혜진',
      snapshotClientBusinessName: '(주)밀텍산업',
      snapshotOperationPersonName: '관리자',
    });
  });

  it('고객사 A→B 변경 → 새 값으로 재작성', () => {
    const patch = buildClientAssignmentTransition({
      previousClientUserId: 5,
      nextClientUserId: 10,
      nextClientUser: clientUser,
      operationUser,
    });

    expect(patch?.snapshotClientPersonName).toBe('윤혜진');
    expect(patch?.operationUserId).toBe(3);
  });

  it('고객사 해제(→null) → client·operation 스냅샷과 operationUserId 초기화', () => {
    const patch = buildClientAssignmentTransition({
      previousClientUserId: 10,
      nextClientUserId: null,
      nextClientUser: null,
      operationUser: null,
    });

    expect(patch).toMatchObject({
      operationUserId: null,
      snapshotClientPersonName: null,
      snapshotClientBusinessName: null,
      snapshotOperationPersonName: null,
    });
  });
});
