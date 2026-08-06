import { UserAuthMainMenuAuthList } from './user.auth.main.menu.auth.list';
import { UserAuthMainEnum, UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';

/**
 * 서브메뉴 → 메인메뉴 역매핑 회귀 테스트.
 *
 * 이 함수는 if 문 나열이라 서브메뉴를 새로 추가할 때 매핑 한 줄을 빠뜨리기 쉽다.
 * 빠뜨리면 권한은 정상인데 사이드바의 상위 메뉴가 통째로 안 열려, "권한을 줬는데
 * 화면이 없다"는 형태로만 드러난다. 신규 메뉴는 여기서 함께 고정한다.
 */
describe('UserAuthMainMenuAuthList', () => {
  it('권한이 없으면 빈 배열', () => {
    expect(UserAuthMainMenuAuthList([])).toEqual([]);
  });

  it('DEPOSIT_HISTORY(입금내역)는 정산관리 메인메뉴로 매핑된다', () => {
    expect(UserAuthMainMenuAuthList([UserAuthSubEnum.DEPOSIT_HISTORY])).toEqual([UserAuthMainEnum.SETTLEMENT]);
  });

  it('같은 메인메뉴의 서브메뉴가 여럿이어도 메인메뉴는 중복되지 않는다', () => {
    const result = UserAuthMainMenuAuthList([UserAuthSubEnum.DEPOSIT_HISTORY, UserAuthSubEnum.SETTLEMENT_CODE]);

    expect(result).toEqual([UserAuthMainEnum.SETTLEMENT]);
  });

  it('서로 다른 영역의 서브메뉴는 각각의 메인메뉴로 매핑된다', () => {
    const result = UserAuthMainMenuAuthList([UserAuthSubEnum.ORDER_GENERAL, UserAuthSubEnum.DEPOSIT_HISTORY]);

    expect(result).toEqual(expect.arrayContaining([UserAuthMainEnum.ORDER, UserAuthMainEnum.SETTLEMENT]));
    expect(result).toHaveLength(2);
  });
});
