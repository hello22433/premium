import { ProductService } from './product.service';
import { IProductUseStatus } from '../interface/product.status';
import { IUserSyncProductStatus } from '../../user_sync_product/interface/user.sync.product.status';

/**
 * ProductService.getLinkAverageExpireDay
 *
 * 담당자(headPersonUserId)의 ACTIVE 연동 이벤트에 매핑된 상품들의
 * 유효기간(galaxia_duration 우선, 없으면 expire_day) 평균을 반환한다.
 */
describe('ProductService.getLinkAverageExpireDay', () => {
  const HEAD_PERSON_USER_ID = 7;

  // createQueryBuilder 체인 mock 팩토리
  const makeQbMock = (rawResult: { averageExpireDay: string | null } | undefined) => {
    const getRawOne = jest.fn().mockResolvedValue(rawResult);
    const qb = {
      select: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawOne,
    };
    return { qb, getRawOne };
  };

  const makeSut = (rawResult: { averageExpireDay: string | null } | undefined) => {
    const { qb, getRawOne } = makeQbMock(rawResult);
    const sut: any = Object.create(ProductService.prototype);
    sut.userSyncProductEventRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    };
    return { sut, qb, getRawOne };
  };

  // ─── 정상 케이스 ───────────────────────────────────────────────────────────

  it('연동상품이 있으면 평균값을 number로 반환한다', async () => {
    const { sut } = makeSut({ averageExpireDay: '28.4000' });

    const result = await sut.getLinkAverageExpireDay(HEAD_PERSON_USER_ID);

    expect(result).toEqual({ averageExpireDay: 28.4 });
  });

  it('MySQL AVG는 string을 반환하므로 Number()로 변환한다', async () => {
    const { sut } = makeSut({ averageExpireDay: '60.0000' });

    const result = await sut.getLinkAverageExpireDay(HEAD_PERSON_USER_ID);

    expect(result.averageExpireDay).toBe(60);
    expect(typeof result.averageExpireDay).toBe('number');
  });

  it('평균이 정수로 딱 떨어지는 경우도 number로 반환한다', async () => {
    const { sut } = makeSut({ averageExpireDay: '30.0000' });

    const result = await sut.getLinkAverageExpireDay(HEAD_PERSON_USER_ID);

    expect(result).toEqual({ averageExpireDay: 30 });
  });

  // ─── null 케이스 ───────────────────────────────────────────────────────────

  it('연동상품이 없으면 DB AVG는 null — averageExpireDay: null 반환', async () => {
    const { sut } = makeSut({ averageExpireDay: null });

    const result = await sut.getLinkAverageExpireDay(HEAD_PERSON_USER_ID);

    expect(result).toEqual({ averageExpireDay: null });
  });

  it('getRawOne이 undefined를 반환하면 averageExpireDay: null 반환', async () => {
    const { sut } = makeSut(undefined);

    const result = await sut.getLinkAverageExpireDay(HEAD_PERSON_USER_ID);

    expect(result).toEqual({ averageExpireDay: null });
  });

  // ─── QueryBuilder 호출 검증 ────────────────────────────────────────────────

  it('createQueryBuilder를 "e" 별칭으로 시작한다', async () => {
    const { sut } = makeSut({ averageExpireDay: '30.0000' });

    await sut.getLinkAverageExpireDay(HEAD_PERSON_USER_ID);

    expect(sut.userSyncProductEventRepository.createQueryBuilder).toHaveBeenCalledWith('e');
  });

  it('galaxia_duration 우선, 없으면 expire_day로 AVG를 구한다', async () => {
    const { sut, qb } = makeSut({ averageExpireDay: '30.0000' });

    await sut.getLinkAverageExpireDay(HEAD_PERSON_USER_ID);

    expect(qb.select).toHaveBeenCalledWith('AVG(COALESCE(p.galaxia_duration, p.expire_day))', 'averageExpireDay');
  });

  it('매핑 테이블을 soft-delete 필터와 함께 JOIN한다', async () => {
    const { sut, qb } = makeSut({ averageExpireDay: '30.0000' });

    await sut.getLinkAverageExpireDay(HEAD_PERSON_USER_ID);

    expect(qb.innerJoin).toHaveBeenCalledWith('e.userSyncProductEventMappings', 'm', 'm.deletedAt IS NULL');
  });

  it('상품 테이블을 soft-delete + USE 상태 필터와 함께 JOIN한다', async () => {
    const { sut, qb } = makeSut({ averageExpireDay: '30.0000' });

    await sut.getLinkAverageExpireDay(HEAD_PERSON_USER_ID);

    expect(qb.innerJoin).toHaveBeenCalledWith('m.product', 'p', 'p.deletedAt IS NULL AND p.useStatus = :useStatus', {
      useStatus: IProductUseStatus.USE,
    });
  });

  it('headPersonUserId로 이벤트를 필터링한다', async () => {
    const { sut, qb } = makeSut({ averageExpireDay: '30.0000' });

    await sut.getLinkAverageExpireDay(HEAD_PERSON_USER_ID);

    expect(qb.where).toHaveBeenCalledWith('e.businessUserId = :headPersonUserId', {
      headPersonUserId: HEAD_PERSON_USER_ID,
    });
  });

  it('ACTIVE 이벤트만 포함한다 (STOPPED/CLOSED 제외)', async () => {
    const { sut, qb } = makeSut({ averageExpireDay: '30.0000' });

    await sut.getLinkAverageExpireDay(HEAD_PERSON_USER_ID);

    expect(qb.andWhere).toHaveBeenCalledWith('e.status = :active', { active: IUserSyncProductStatus.ACTIVE });
  });

  it('soft-delete된 이벤트를 제외한다', async () => {
    const { sut, qb } = makeSut({ averageExpireDay: '30.0000' });

    await sut.getLinkAverageExpireDay(HEAD_PERSON_USER_ID);

    expect(qb.andWhere).toHaveBeenCalledWith('e.deletedAt IS NULL');
  });
});
