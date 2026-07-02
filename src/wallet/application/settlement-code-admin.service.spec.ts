import { BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { UserEntity } from '../../entity/user.entity';
import { WalletAccountEntity } from '../../entity/wallet.account.entity';
import { OrderEntity } from '../../entity/order.entity';
import { PointGrantEntity } from '../../entity/point.grant.entity';
import { SettlementCodeAdminService } from './settlement-code-admin.service';
import { BillingScopeLockService } from './billing-scope-lock.service';

/** DISTINCT settlementCode 조회용 query builder mock (classifyJoin 용). getRawMany 결과를 주입. */
function makeDistinctQb(rows: { code: string | null }[]) {
  const qb: any = {};
  for (const m of ['select', 'where', 'andWhere']) {
    qb[m] = jest.fn(() => qb);
  }
  qb.getRawMany = jest.fn(async () => rows);
  return qb;
}

/**
 * listPendingAccounts 용 query builder mock. select/addSelect/where/andWhere 를 지원하고
 * getRawMany 는 시드된 user 목록에 서비스와 동일한 술어(회사 일치 + deletedAt IS NULL + code ''/NULL)를
 * 적용한다. andWhere(Brackets) 콜백까지 실행해 적용된 SQL 절을 cap.clauses 에 기록한다.
 */
function makePendingQb(users: any[], cap: { clauses: string[] }) {
  let companyId: number | undefined;
  const qb: any = {};
  qb.select = jest.fn(() => qb);
  qb.addSelect = jest.fn(() => qb);
  qb.where = jest.fn((sql: string, params?: any) => {
    cap.clauses.push(sql);
    if (params && 'companyId' in params) companyId = params.companyId;
    return qb;
  });
  qb.andWhere = jest.fn((arg: any) => {
    if (arg && typeof arg.whereFactory === 'function') {
      const sub: any = {
        where: jest.fn((s: string) => {
          cap.clauses.push(s);
          return sub;
        }),
        orWhere: jest.fn((s: string) => {
          cap.clauses.push(s);
          return sub;
        }),
      };
      arg.whereFactory(sub);
    } else {
      cap.clauses.push(arg);
    }
    return qb;
  });
  qb.getRawMany = jest.fn(async () =>
    users
      .filter(
        (u) =>
          u.companyId === companyId &&
          u.deletedAt == null &&
          u.status !== 'LEAVE' &&
          (u.settlementCode == null || u.settlementCode === ''),
      )
      .map((u) => ({ userId: u.id, personName: u.personName })),
  );
  return qb;
}

/** 트랜잭션 매니저 fixture. */
interface ManagerFixture {
  movingUserAllSettle: number;
  outstandingCount: number;
  walletGetOne: Partial<WalletAccountEntity> | null;
  issuedOwnerRows: { ownerId: string }[];
  pointsTotal: number;
  foreignRefCount: number;
  ensureAffected: number;
}

interface Captured {
  userUpdate: { crit: any; patch: any }[];
  walletUpdate: { crit: any; patch: any }[];
  walletSave: any[];
  queries: { sql: string; params: any[] }[];
  setLockModes: string[];
  pointWhere: string[];
}

function makeManager(fx: ManagerFixture, cap: Captured) {
  const walletRepo = {
    createQueryBuilder: () => {
      const qb: any = {
        setLock: (mode: string) => {
          cap.setLockModes.push(mode);
          return qb;
        },
        select: () => qb,
        where: () => qb,
        andWhere: () => qb,
        getOne: async () => fx.walletGetOne ?? null,
        getRawMany: async () => fx.issuedOwnerRows,
      };
      return qb;
    },
    update: async (crit: any, patch: any) => {
      cap.walletUpdate.push({ crit, patch });
      return { affected: 1 };
    },
    save: async (w: any) => {
      cap.walletSave.push(w);
      return w;
    },
  };
  const userRepoTx = {
    findOne: async () => ({ id: 1, allSettleAmount: fx.movingUserAllSettle }),
    createQueryBuilder: () => {
      const qb: any = { where: () => qb, andWhere: () => qb, getCount: async () => fx.foreignRefCount };
      return qb;
    },
    update: async (crit: any, patch: any) => {
      cap.userUpdate.push({ crit, patch });
      return { affected: 1 };
    },
  };
  const orderRepo = {
    createQueryBuilder: () => {
      const qb: any = { where: () => qb, andWhere: () => qb, getCount: async () => fx.outstandingCount };
      return qb;
    },
  };
  const pointRepo = {
    createQueryBuilder: () => {
      const qb: any = {
        select: () => qb,
        where: () => qb,
        andWhere: (sql: string) => {
          cap.pointWhere.push(sql);
          return qb;
        },
        getRawOne: async () => ({ total: String(fx.pointsTotal) }),
      };
      return qb;
    },
  };
  return {
    query: async (sql: string, params: any[]) => {
      cap.queries.push({ sql, params });
      return { affectedRows: fx.ensureAffected };
    },
    getRepository: (e: any) => {
      if (e === WalletAccountEntity) return walletRepo;
      if (e === UserEntity) return userRepoTx;
      if (e === OrderEntity) return orderRepo;
      if (e === PointGrantEntity) return pointRepo;
      return {};
    },
  };
}

describe('SettlementCodeAdminService', () => {
  let sut: SettlementCodeAdminService;
  let userRepo: jest.Mocked<Repository<UserEntity>>;
  let billingScopeLock: { lock: jest.Mock; lockByCompany: jest.Mock };
  let activityLogService: { createLog: jest.Mock };
  let dataSource: { transaction: jest.Mock };

  let fx: ManagerFixture;
  let cap: Captured;
  let lockResult: { user: any; companyUsers: any[] };
  let lockByCompanyResult: { company: any; companyUsers: any[] };

  beforeEach(() => {
    userRepo = { createQueryBuilder: jest.fn() } as any;
    billingScopeLock = {
      lock: jest.fn(async () => lockResult),
      lockByCompany: jest.fn(async () => lockByCompanyResult),
    };
    lockByCompanyResult = {
      company: { id: 7 },
      companyUsers: [{ id: 1, settlementCode: 'company-7', companyId: 7 }],
    };
    activityLogService = { createLog: jest.fn(async () => 1) };
    fx = {
      movingUserAllSettle: 0,
      outstandingCount: 0,
      walletGetOne: null,
      issuedOwnerRows: [],
      pointsTotal: 0,
      foreignRefCount: 0,
      ensureAffected: 1,
    };
    cap = { userUpdate: [], walletUpdate: [], walletSave: [], queries: [], setLockModes: [], pointWhere: [] };
    dataSource = {
      transaction: jest.fn(async (cb: (m: any) => any) => cb(makeManager(fx, cap))),
    };
    sut = new SettlementCodeAdminService(
      userRepo as any,
      dataSource as any,
      billingScopeLock as unknown as BillingScopeLockService,
      activityLogService as any,
    );
  });

  // ── classifyJoin (PR-A regression) ────────────────────────────────────────
  describe('classifyJoin', () => {
    it('companyId 없음 → PENDING', async () => {
      expect(await sut.classifyJoin(null, false)).toEqual({ mode: 'PENDING' });
    });
    it('isNewCompany → NEW company-{id}', async () => {
      expect(await sut.classifyJoin(42, true)).toEqual({ mode: 'NEW', code: 'company-42' });
    });
    it('기존 회사 code 1개 → SHARE_ONE', async () => {
      userRepo.createQueryBuilder.mockReturnValue(makeDistinctQb([{ code: 'company-7' }]) as any);
      expect(await sut.classifyJoin(7, false)).toEqual({ mode: 'SHARE_ONE', code: 'company-7' });
    });
    it('기존 회사 code 0개 → PENDING', async () => {
      userRepo.createQueryBuilder.mockReturnValue(makeDistinctQb([]) as any);
      expect(await sut.classifyJoin(7, false)).toEqual({ mode: 'PENDING' });
    });
    it('기존 회사 code 2개 이상 → PENDING', async () => {
      userRepo.createQueryBuilder.mockReturnValue(makeDistinctQb([{ code: 'a' }, { code: 'b' }]) as any);
      expect(await sut.classifyJoin(7, false)).toEqual({ mode: 'PENDING' });
    });
  });

  // ── ensureSettlementCodeWallet (PR-A regression) ──────────────────────────
  describe('ensureSettlementCodeWallet', () => {
    it('ON DUPLICATE KEY UPDATE id=id 로 멱등 생성 (정책 기본값 POST_PAYMENT/CASH)', async () => {
      const manager: any = { query: jest.fn().mockResolvedValue({ affectedRows: 1 }) };
      await sut.ensureSettlementCodeWallet(7, 'company-7', 5000, manager);
      const [sql, params] = manager.query.mock.calls[0];
      expect(sql).toMatch(/ON DUPLICATE KEY UPDATE\s+id\s*=\s*id/i);
      expect(params).toEqual(['company-7', 5000, 'POST_PAYMENT', 'CASH']);
    });
    it('settleCondition/settleMethod 인자를 wallet 정책 컬럼에 반영한다', async () => {
      const manager: any = { query: jest.fn().mockResolvedValue({ affectedRows: 1 }) };
      await sut.ensureSettlementCodeWallet(7, 'company-7', 5000, manager, 'PRE_PAYMENT', 'CARD');
      const [, params] = manager.query.mock.calls[0];
      expect(params).toEqual(['company-7', 5000, 'PRE_PAYMENT', 'CARD']);
    });
    it('중복(affectedRows=0) → log.warn + 성공', async () => {
      const manager: any = { query: jest.fn().mockResolvedValue({ affectedRows: 0 }) };
      const warnSpy = jest.spyOn((sut as any).logger, 'warn');
      await expect(sut.ensureSettlementCodeWallet(7, 'company-7', 5000, manager)).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
    });
  });

  // ── assignUserToCode ──────────────────────────────────────────────────────
  describe('assignUserToCode', () => {
    it('빈 targetCode → BadRequest', async () => {
      await expect(sut.assignUserToCode(1, '   ')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('targetCode 가 회사의 기존 코드가 아니면 BadRequest (target-company validation)', async () => {
      const moving = { id: 1, settlementCode: 'company-7', companyId: 7 };
      lockResult = { user: moving, companyUsers: [moving] };
      await expect(sut.assignUserToCode(1, 'company-999')).rejects.toBeInstanceOf(BadRequestException);
      expect(cap.userUpdate).toHaveLength(0);
    });

    it('all_settle != 0 → 변경 게이트 차단', async () => {
      const moving = { id: 1, settlementCode: 'company-7', companyId: 7 };
      const other = { id: 2, settlementCode: 'company-7-1', companyId: 7 };
      lockResult = { user: moving, companyUsers: [moving, other] };
      fx.movingUserAllSettle = 15000;
      await expect(sut.assignUserToCode(1, 'company-7-1')).rejects.toThrow(/미정산 외상 잔액/);
      expect(cap.userUpdate).toHaveLength(0);
    });

    it('진행 중/미정산 주문(REVIEW_COMPLETE·DELIVERY_COMPLETE-미정산 포함) → 차단', async () => {
      const moving = { id: 1, settlementCode: 'company-7', companyId: 7 };
      const other = { id: 2, settlementCode: 'company-7-1', companyId: 7 };
      lockResult = { user: moving, companyUsers: [moving, other] };
      fx.outstandingCount = 1; // 진행 중/미정산 주문 존재
      await expect(sut.assignUserToCode(1, 'company-7-1')).rejects.toThrow(/진행 중이거나 미정산/);
      expect(cap.userUpdate).toHaveLength(0);
    });

    it('마지막 사용자 + SOURCE 풀 비어있지 않음 → pool-orphan 차단', async () => {
      const moving = { id: 1, settlementCode: 'company-7', companyId: 7 };
      const other = { id: 2, settlementCode: 'company-7-1', companyId: 7 };
      lockResult = { user: moving, companyUsers: [moving, other] };
      fx.walletGetOne = { id: 'w-7', depositBalance: 5000, creditUsedAmount: 0, creditExcessAmount: 0 };
      await expect(sut.assignUserToCode(1, 'company-7-1')).rejects.toThrow(/고아/);
      // SOURCE wallet 은 NOWAIT 로 잠갔다.
      expect(cap.setLockModes).toContain('pessimistic_write_or_fail');
      expect(cap.userUpdate).toHaveLength(0);
    });

    it('마지막 사용자 + SOURCE 풀 비어있음 → 통과, settlement_code field 만 갱신 (자금 이동 없음)', async () => {
      const moving = { id: 1, settlementCode: 'company-7', companyId: 7 };
      const other = { id: 2, settlementCode: 'company-7-1', companyId: 7 };
      lockResult = { user: moving, companyUsers: [moving, other] };
      fx.walletGetOne = { id: 'w-7', depositBalance: 0, creditUsedAmount: 0, creditExcessAmount: 0 };
      fx.pointsTotal = 0;
      await sut.assignUserToCode(1, 'company-7-1');
      expect(cap.userUpdate).toEqual([{ crit: { id: 1 }, patch: { settlementCode: 'company-7-1' } }]);
      // 자금 이동/저장 없음.
      expect(cap.walletSave).toHaveLength(0);
      // 만료된 포인트는 이동 차단 계산에서 제외한다 (미만료 잔여만 카운트, MED-1).
      expect(cap.pointWhere).toContain('(p.expiresAt IS NULL OR p.expiresAt > :now)');
    });

    it('마지막 사용자 아님(co-user 잔존) → 풀 비어있지 않아도 통과', async () => {
      const moving = { id: 1, settlementCode: 'company-7', companyId: 7 };
      const coUser = { id: 2, settlementCode: 'company-7', companyId: 7 };
      const target = { id: 3, settlementCode: 'company-7-1', companyId: 7 };
      lockResult = { user: moving, companyUsers: [moving, coUser, target] };
      fx.walletGetOne = { id: 'w-7', depositBalance: 99999, creditUsedAmount: 0, creditExcessAmount: 0 };
      await sut.assignUserToCode(1, 'company-7-1');
      expect(cap.userUpdate).toEqual([{ crit: { id: 1 }, patch: { settlementCode: 'company-7-1' } }]);
    });

    it('sourceCode == targetCode → no-op', async () => {
      const moving = { id: 1, settlementCode: 'company-7', companyId: 7 };
      lockResult = { user: moving, companyUsers: [moving] };
      await sut.assignUserToCode(1, 'company-7');
      expect(cap.userUpdate).toHaveLength(0);
    });
  });

  // ── issueNewCode ──────────────────────────────────────────────────────────
  describe('issueNewCode', () => {
    it('기존 suffix 없음 → company-{id}-1 발급 + ensure wallet(creditLimit=0) + code 갱신', async () => {
      const moving = {
        id: 1,
        settlementCode: 'company-7',
        companyId: 7,
        settleCondition: 'PRE_PAYMENT',
        settleMethod: 'CARD',
      };
      lockResult = { user: moving, companyUsers: [moving, { id: 2, settlementCode: 'company-7' }] };
      fx.issuedOwnerRows = [];
      const code = await sut.issueNewCode(1);
      expect(code).toBe('company-7-1');
      // ensureSettlementCodeWallet 은 creditLimit=0 으로 INSERT.
      expect(cap.queries[0].params).toEqual(['company-7-1', 0, 'PRE_PAYMENT', 'CARD']);
      expect(cap.userUpdate).toEqual([{ crit: { id: 1 }, patch: { settlementCode: 'company-7-1' } }]);
    });

    it('기존 suffix 최댓값 +1 (numbering, non-numeric 무시) — 단일 회사 잠금 하 순차', async () => {
      const moving = { id: 1, settlementCode: 'company-7', companyId: 7 };
      lockResult = { user: moving, companyUsers: [moving, { id: 2, settlementCode: 'company-7' }] };
      fx.issuedOwnerRows = [{ ownerId: 'company-7-1' }, { ownerId: 'company-7-2' }, { ownerId: 'company-7-mkt' }];
      const code = await sut.issueNewCode(1);
      expect(code).toBe('company-7-3');
    });

    it('회사 없는 계정 → BadRequest', async () => {
      const moving = { id: 1, settlementCode: '', companyId: null };
      lockResult = { user: moving, companyUsers: [moving] };
      await expect(sut.issueNewCode(1)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('lock-conflict 발생 시 1회 재시도한다 (NOWAIT)', async () => {
      const moving = { id: 1, settlementCode: 'company-7', companyId: 7 };
      lockResult = { user: moving, companyUsers: [moving, { id: 2, settlementCode: 'company-7' }] };
      let calls = 0;
      dataSource.transaction.mockImplementation(async (cb: any) => {
        calls += 1;
        if (calls === 1) {
          const e: any = new Error('NOWAIT lock');
          e.errno = 3572;
          throw e;
        }
        return cb(makeManager(fx, cap));
      });
      const code = await sut.issueNewCode(1);
      expect(code).toBe('company-7-1');
      expect(dataSource.transaction).toHaveBeenCalledTimes(2);
    });
  });

  // ── renameCode ────────────────────────────────────────────────────────────
  describe('renameCode', () => {
    it('newCode wallet 이 이미 있으면 collision BadRequest (원자성 — update 없음)', async () => {
      fx.walletGetOne = { id: 'w-x', ownerId: 'company-7-new' };
      await expect(sut.renameCode(7, 'company-7', 'company-7-new')).rejects.toThrow(/이미 존재/);
      expect(cap.walletUpdate).toHaveLength(0);
      expect(cap.userUpdate).toHaveLength(0);
    });

    it('collision 없음 → wallet.owner_id + 모든 참조 user.settlement_code 를 한 TX 에서 갱신', async () => {
      fx.walletGetOne = null; // newCode 부재
      await sut.renameCode(7, 'company-7', 'company-7-new');
      expect(cap.walletUpdate).toEqual([
        { crit: { ownerType: 'SETTLEMENT_CODE', ownerId: 'company-7' }, patch: { ownerId: 'company-7-new' } },
      ]);
      expect(cap.userUpdate).toEqual([
        { crit: { companyId: 7, settlementCode: 'company-7' }, patch: { settlementCode: 'company-7-new' } },
      ]);
    });

    it('oldCode 가 이 회사 소속 코드가 아니면 BadRequest (타 회사 code 전역 rename 방지, H5)', async () => {
      lockByCompanyResult = {
        company: { id: 7 },
        companyUsers: [{ id: 1, settlementCode: 'company-7', companyId: 7 }],
      };
      await expect(sut.renameCode(7, 'company-999', 'company-999-new')).rejects.toThrow(/속한 코드가 아닙니다/);
      expect(cap.walletUpdate).toHaveLength(0);
      expect(cap.userUpdate).toHaveLength(0);
    });

    it('oldCode 가 타 회사(또는 회사미연결) 사용자에서도 참조되면 BadRequest (전역 rename drift 차단, H5)', async () => {
      // 이 회사 소속 검증은 통과하나, 타 회사 참조가 있어 fail-closed.
      fx.foreignRefCount = 1;
      fx.walletGetOne = null;
      await expect(sut.renameCode(7, 'company-7', 'company-7-new')).rejects.toThrow(/타 회사.*참조/);
      expect(cap.walletUpdate).toHaveLength(0);
      expect(cap.userUpdate).toHaveLength(0);
    });

    it('oldCode == newCode → BadRequest', async () => {
      await expect(sut.renameCode(7, 'company-7', 'company-7')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ── setCodeCreditLimit ────────────────────────────────────────────────────
  describe('setCodeCreditLimit', () => {
    const operator = { id: 99, email: 'op@test.com', authority: 'OPERATION_ADMIN' } as any;

    it('creditLimit < 0 → BadRequest', async () => {
      await expect(sut.setCodeCreditLimit('company-7', -1, operator)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('wallet 미존재 → BadRequest', async () => {
      fx.walletGetOne = null;
      await expect(sut.setCodeCreditLimit('company-7', 100, operator)).rejects.toThrow(/찾을 수 없/);
    });

    it('wallet FOR UPDATE + creditLimit 갱신 + activity_log(before/after) 기록', async () => {
      fx.walletGetOne = { id: 'w-7', ownerId: 'company-7', creditLimit: 5000 };
      const r = await sut.setCodeCreditLimit('company-7', 20000, operator);
      expect(r).toEqual({ settlementCode: 'company-7', before: 5000, after: 20000 });
      expect(cap.setLockModes).toContain('pessimistic_write');
      expect(cap.walletSave[0]).toEqual(expect.objectContaining({ creditLimit: 20000 }));
      expect(activityLogService.createLog).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 99,
          userEmail: 'op@test.com',
          requestParams: expect.objectContaining({
            settlementCode: 'company-7',
            beforeMaximumLimit: 5000,
            afterMaximumLimit: 20000,
          }),
        }),
      );
    });
  });
  // ── listPendingAccounts ───────────────────────────────────────────────────
  describe('listPendingAccounts', () => {
    const users = [
      { id: 3, personName: 'C', companyId: 7, settlementCode: '', deletedAt: null }, // 활성 + 빈 code
      { id: 4, personName: 'D', companyId: 7, settlementCode: null, deletedAt: null }, // 활성 + NULL code
      { id: 5, personName: 'E', companyId: 7, settlementCode: 'company-7', deletedAt: null }, // code 보유 → 제외
      { id: 6, personName: 'F', companyId: 7, settlementCode: '', deletedAt: new Date() }, // soft-delete → 제외
      { id: 7, personName: 'G', companyId: 99, settlementCode: '', deletedAt: null }, // 타 회사 → 제외
    ];

    it("빈 code(''/NULL) 활성 사용자만 반환 — code 보유·삭제·타회사 제외 + 응답 shape", async () => {
      const cap = { clauses: [] as string[] };
      userRepo.createQueryBuilder.mockReturnValue(makePendingQb(users, cap) as any);
      const r = await sut.listPendingAccounts(7);
      expect(r).toEqual({
        companyId: 7,
        pendingUsers: [
          { userId: 3, personName: 'C' },
          { userId: 4, personName: 'D' },
        ],
      });
      // 배제 술어가 쿼리에 반영됐는지: soft-delete 제외 + empty/NULL code.
      expect(cap.clauses).toContain('u.deletedAt IS NULL');
      expect(cap.clauses).toContain('u.settlementCode IS NULL');
      expect(cap.clauses).toContain("u.settlementCode = ''");
    });

    it('대기 계정 없음 → 빈 배열', async () => {
      const cap = { clauses: [] as string[] };
      userRepo.createQueryBuilder.mockReturnValue(
        makePendingQb(
          [{ id: 5, personName: 'E', companyId: 7, settlementCode: 'company-7', deletedAt: null }],
          cap,
        ) as any,
      );
      expect(await sut.listPendingAccounts(7)).toEqual({ companyId: 7, pendingUsers: [] });
    });
  });
});
