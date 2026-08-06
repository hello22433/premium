import { UserAuthListDefault } from './user.auth.list.default';
import { IUserAuthority } from '../../user/interface/user.authority';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';

/**
 * UserAuthListDefault 회귀 테스트.
 *
 * 배경: 생성/수정 시 모든 역할이 authority_list 를 CSV 로 저장한다(서비스 layer).
 * 과거에는 `if (authorityList !== null) return CSV` 가 SUPER_ADMIN 의 전체권한 분기보다
 * 먼저 평가돼, 화면에서 저장된 SUPER_ADMIN 은 CSV 에 없는 신규 메뉴(FORBIDDEN_WORD 등)를
 * 누락했다(메뉴 숨김 + authorityValidator 403). 본 스펙은 SUPER_ADMIN 이 저장된
 * authority_list 와 무관하게 항상 전체 권한을 받는지, 그리고 OPERATION_ADMIN 의
 * 메뉴별 제한(CSV verbatim)은 그대로 보존되는지를 검증한다.
 */
describe('UserAuthListDefault', () => {
  describe('SUPER_ADMIN 은 저장된 authority_list 와 무관하게 항상 전체 권한', () => {
    const allKeys = Object.values(UserAuthSubEnum);

    it('authority_list 가 null 이면 전체 권한', () => {
      expect(UserAuthListDefault(IUserAuthority.SUPER_ADMIN, null)).toEqual(allKeys);
    });

    it('FORBIDDEN_WORD 가 빠진 CSV 가 저장돼 있어도 전체 권한(FORBIDDEN_WORD 포함)', () => {
      const legacyCsv = 'ORDER_GENERAL,SEND_GENERAL,ACCOUNT';
      const result = UserAuthListDefault(IUserAuthority.SUPER_ADMIN, legacyCsv);

      expect(result).toEqual(allKeys);
      expect(result).toContain(UserAuthSubEnum.FORBIDDEN_WORD);
    });

    it('빈 문자열 CSV 여도 전체 권한', () => {
      expect(UserAuthListDefault(IUserAuthority.SUPER_ADMIN, '')).toEqual(allKeys);
    });

    it('SETTLEMENT_CODE(정산코드 관리)가 전체 권한에 포함된다', () => {
      const result = UserAuthListDefault(IUserAuthority.SUPER_ADMIN, null);
      expect(result).toContain(UserAuthSubEnum.SETTLEMENT_CODE);
    });

    it('DEPOSIT_HISTORY(입금내역)가 전체 권한에 포함된다', () => {
      const result = UserAuthListDefault(IUserAuthority.SUPER_ADMIN, null);
      expect(result).toContain(UserAuthSubEnum.DEPOSIT_HISTORY);
    });
  });

  describe('OPERATION_ADMIN 의 메뉴별 제한은 보존된다 (CSV verbatim)', () => {
    it('저장된 CSV 가 그대로 반환된다 (전체 권한으로 덮어쓰지 않음)', () => {
      const csv = 'ORDER_GENERAL,FORBIDDEN_WORD';
      expect(UserAuthListDefault(IUserAuthority.OPERATION_ADMIN, csv)).toEqual([
        UserAuthSubEnum.ORDER_GENERAL,
        UserAuthSubEnum.FORBIDDEN_WORD,
      ]);
    });

    it('authority_list 가 null 이면 기본 권한 목록(FORBIDDEN_WORD 포함)', () => {
      const result = UserAuthListDefault(IUserAuthority.OPERATION_ADMIN, null);
      expect(result).toContain(UserAuthSubEnum.FORBIDDEN_WORD);
    });

    it('SETTLEMENT_CODE 는 기본 권한 목록에 포함되지 않는다 (권한관리 화면에서 개별 부여)', () => {
      const result = UserAuthListDefault(IUserAuthority.OPERATION_ADMIN, null);
      expect(result).not.toContain(UserAuthSubEnum.SETTLEMENT_CODE);
    });

    // 은행 계좌·예금주 실명·금액을 다루므로 운영자 전원에게 자동 부여하지 않는다.
    it('DEPOSIT_HISTORY 는 기본 권한 목록에 포함되지 않는다 (권한관리 화면에서 개별 부여)', () => {
      const result = UserAuthListDefault(IUserAuthority.OPERATION_ADMIN, null);
      expect(result).not.toContain(UserAuthSubEnum.DEPOSIT_HISTORY);
    });
  });

  describe('CORPORATE_ADMIN', () => {
    it('null 이면 제한된 기본 목록이며 FORBIDDEN_WORD 를 포함하지 않는다', () => {
      const result = UserAuthListDefault(IUserAuthority.CORPORATE_ADMIN, null);
      expect(result).not.toContain(UserAuthSubEnum.FORBIDDEN_WORD);
    });
  });
});
