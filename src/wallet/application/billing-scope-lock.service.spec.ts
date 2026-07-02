import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { InternalServerErrorException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { UserEntity } from '../../entity/user.entity';
import { UserCompanyEntity } from '../../entity/user.company.entity';
import { BillingScopeLockService } from './billing-scope-lock.service';

/** setLock('pessimistic_write') 이 걸린 체이닝 query builder mock. 호출 순서를 log 에 기록. */
function makeQb(tag: string, log: string[], result: unknown, kind: 'one' | 'many') {
  const qb: any = {};
  for (const m of ['setLock', 'leftJoinAndSelect', 'where', 'orderBy']) {
    qb[m] = jest.fn((...args: any[]) => {
      if (m === 'setLock') log.push(`${tag}:setLock:${args[0]}`);
      if (m === 'orderBy') log.push(`${tag}:orderBy:${args[0]}:${args[1]}`);
      return qb;
    });
  }
  qb.getOne = jest.fn(async () => {
    log.push(`${tag}:getOne`);
    return result;
  });
  qb.getMany = jest.fn(async () => {
    log.push(`${tag}:getMany`);
    return result;
  });
  qb._kind = kind;
  return qb;
}

describe('BillingScopeLockService', () => {
  let sut: BillingScopeLockService;
  let userRepo: jest.Mocked<Repository<UserEntity>>;
  let companyRepo: jest.Mocked<Repository<UserCompanyEntity>>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BillingScopeLockService,
        {
          provide: getRepositoryToken(UserEntity),
          useValue: { findOne: jest.fn(), createQueryBuilder: jest.fn() },
        },
        {
          provide: getRepositoryToken(UserCompanyEntity),
          useValue: { createQueryBuilder: jest.fn() },
        },
      ],
    }).compile();
    sut = module.get(BillingScopeLockService);
    userRepo = module.get(getRepositoryToken(UserEntity));
    companyRepo = module.get(getRepositoryToken(UserCompanyEntity));
  });

  it('회사 소속 유저: 회사 row 를 먼저 잠근 뒤 회사 사용자들을 id ASC 로 잠근다', async () => {
    const log: string[] = [];
    userRepo.findOne.mockResolvedValue({ id: 5, companyId: 7 } as UserEntity);

    const company = { id: 7 } as UserCompanyEntity;
    const companyUsers = [{ id: 3 }, { id: 5 }, { id: 9 }] as UserEntity[];

    companyRepo.createQueryBuilder.mockReturnValue(makeQb('company', log, company, 'one') as any);
    userRepo.createQueryBuilder.mockReturnValue(makeQb('companyUsers', log, companyUsers, 'many') as any);

    const { user, companyUsers: locked } = await sut.lock(5);

    // 잠금 순서: 회사 row(getOne) → 회사 사용자들(getMany)
    const companyIdx = log.indexOf('company:getOne');
    const usersIdx = log.indexOf('companyUsers:getMany');
    expect(companyIdx).toBeGreaterThanOrEqual(0);
    expect(usersIdx).toBeGreaterThanOrEqual(0);
    expect(companyIdx).toBeLessThan(usersIdx);

    // 사용자 잠금은 id ASC
    expect(log).toContain('companyUsers:orderBy:companyUser.id:ASC');
    // 두 쿼리 모두 pessimistic_write lock
    expect(log).toContain('company:setLock:pessimistic_write');
    expect(log).toContain('companyUsers:setLock:pessimistic_write');

    expect(user.id).toBe(5);
    expect(user.company).toBe(company);
    expect(locked).toBe(companyUsers);
  });

  it('companyId 없는 유저: 회사 잠금을 건너뛰고 본인만 잠근다 (null-company path)', async () => {
    const log: string[] = [];
    userRepo.findOne.mockResolvedValue({ id: 11, companyId: null } as UserEntity);

    const soloUser = { id: 11, companyId: null } as UserEntity;
    userRepo.createQueryBuilder.mockReturnValue(makeQb('solo', log, soloUser, 'one') as any);

    const { user, companyUsers } = await sut.lock(11);

    expect(companyRepo.createQueryBuilder).not.toHaveBeenCalled();
    expect(log).toContain('solo:setLock:pessimistic_write');
    expect(user).toBe(soloUser);
    expect(companyUsers).toEqual([soloUser]);
  });

  it('과금 대상 유저가 없으면 InternalServerErrorException', async () => {
    userRepo.findOne.mockResolvedValue(null);
    await expect(sut.lock(999)).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('manager 전달 시 manager.getRepository 로 트랜잭션 매니저를 사용한다', async () => {
    const log: string[] = [];
    const soloUser = { id: 11, companyId: null } as UserEntity;
    const mgrUserRepo = {
      findOne: jest.fn().mockResolvedValue({ id: 11, companyId: null }),
      createQueryBuilder: jest.fn(() => makeQb('mgrSolo', log, soloUser, 'one')),
    };
    const manager: any = { getRepository: jest.fn(() => mgrUserRepo) };

    await sut.lock(11, manager);

    expect(manager.getRepository).toHaveBeenCalledWith(UserEntity);
    expect(userRepo.findOne).not.toHaveBeenCalled();
  });

  it('lockByCompany: 회사 row → 소속 users(id ASC) 순으로 잠근다 (manager 경유)', async () => {
    const log: string[] = [];
    const company = { id: 7 } as UserCompanyEntity;
    const companyUsers = [{ id: 3 }, { id: 5 }] as UserEntity[];
    const mgrCompanyRepo = { createQueryBuilder: jest.fn(() => makeQb('company', log, company, 'one')) };
    const mgrUserRepo = { createQueryBuilder: jest.fn(() => makeQb('companyUsers', log, companyUsers, 'many')) };
    const manager: any = {
      getRepository: jest.fn((e: any) => (e === UserCompanyEntity ? mgrCompanyRepo : mgrUserRepo)),
    };

    const result = await sut.lockByCompany(7, manager);

    const companyIdx = log.indexOf('company:getOne');
    const usersIdx = log.indexOf('companyUsers:getMany');
    expect(companyIdx).toBeGreaterThanOrEqual(0);
    expect(usersIdx).toBeGreaterThanOrEqual(0);
    expect(companyIdx).toBeLessThan(usersIdx);
    expect(log).toContain('company:setLock:pessimistic_write');
    expect(log).toContain('companyUsers:setLock:pessimistic_write');
    expect(log).toContain('companyUsers:orderBy:companyUser.id:ASC');
    expect(result.company).toBe(company);
    expect(result.companyUsers).toBe(companyUsers);
  });

  it('lockByCompany: 회사 없음 → InternalServerErrorException', async () => {
    const log: string[] = [];
    const mgrCompanyRepo = { createQueryBuilder: jest.fn(() => makeQb('company', log, null, 'one')) };
    const manager: any = { getRepository: jest.fn(() => mgrCompanyRepo) };
    await expect(sut.lockByCompany(999, manager)).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});
