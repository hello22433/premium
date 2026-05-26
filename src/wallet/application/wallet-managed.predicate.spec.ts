import { Test, TestingModule } from '@nestjs/testing';
import { DataSource, EntityManager } from 'typeorm';
import { WalletManagedPredicate } from './wallet-managed.predicate';

describe('WalletManagedPredicate', () => {
  let sut: WalletManagedPredicate;
  let dataSource: { manager: any };
  let queryBuilder: {
    select: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    limit: jest.Mock;
    getRawOne: jest.Mock;
  };

  function buildRepo(getRawOneReturn: { exists_flag: number } | null) {
    queryBuilder = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue(getRawOneReturn),
    };
    return {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };
  }

  async function buildSut(getRawOneReturn: { exists_flag: number } | null): Promise<WalletManagedPredicate> {
    const repo = buildRepo(getRawOneReturn);
    dataSource = { manager: { getRepository: jest.fn().mockReturnValue(repo) } };
    const module: TestingModule = await Test.createTestingModule({
      providers: [WalletManagedPredicate, { provide: DataSource, useValue: dataSource }],
    }).compile();
    return module.get(WalletManagedPredicate);
  }

  it('allocation 존재 + released_at IS NULL → true', async () => {
    sut = await buildSut({ exists_flag: 1 });
    await expect(sut.isWalletManaged(1234)).resolves.toBe(true);
    expect(queryBuilder.where).toHaveBeenCalledWith('a.order_id = :orderId', { orderId: 1234 });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('a.released_at IS NULL');
    expect(queryBuilder.limit).toHaveBeenCalledWith(1);
  });

  it('allocation 부재 → false', async () => {
    sut = await buildSut(null);
    await expect(sut.isWalletManaged(9999)).resolves.toBe(false);
  });

  it('released 된 allocation (released_at IS NOT NULL) → false (필터링됨)', async () => {
    // released_at IS NULL 필터 때문에 released 된 allocation 은 결과에 포함되지 않음 → null
    sut = await buildSut(null);
    await expect(sut.isWalletManaged(5555)).resolves.toBe(false);
  });

  it('manager 인자 전달 시 같은 트랜잭션 매니저의 repository 사용 (same-tx)', async () => {
    sut = await buildSut({ exists_flag: 1 });

    const txManagerRepo = buildRepo({ exists_flag: 1 });
    const txManager = { getRepository: jest.fn().mockReturnValue(txManagerRepo) } as unknown as EntityManager;

    await expect(sut.isWalletManaged(1234, txManager)).resolves.toBe(true);
    expect(txManager.getRepository).toHaveBeenCalled();
    // dataSource.manager.getRepository 는 호출되지 않아야 함 (manager 전달했으므로)
    expect(dataSource.manager.getRepository).not.toHaveBeenCalled();
  });
});
