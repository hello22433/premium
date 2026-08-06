import { BadRequestException, ConflictException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { UserEntity } from '../../entity/user.entity';
import { UserCompanyEntity } from '../../entity/user.company.entity';
import { WalletAccountEntity } from '../../entity/wallet.account.entity';
import { OrderEntity } from '../../entity/order.entity';
import { PointGrantEntity } from '../../entity/point.grant.entity';
import { WalletTransactionEntity } from '../../entity/wallet.transaction.entity';
import { SettlementCodeAdminService } from './settlement-code-admin.service';
import { BillingScopeLockService } from './billing-scope-lock.service';
import { ActivityLogActionType } from '../../activity_log/interface/activity.log.action.type';

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
  codeUsers?: { id: number }[];
  globalCodeUserCount?: number;
  codeCompanyIdRows?: { companyId: number }[];
  existingTx?: { amount: number; balanceAfter: number | null } | null;
  walletByCode?: Record<string, Partial<WalletAccountEntity> | null>;
  companylessUsers?: { id: number }[];
  outstandingOrderRows?: { id: number; uid: number; status?: string; settleStatus?: string | null }[];
  companyRow?: { id: number } | null;
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
      let capturedCode: string | undefined;
      const qb: any = {
        setLock: (mode: string) => {
          cap.setLockModes.push(mode);
          return qb;
        },
        select: () => qb,
        where: () => qb,
        andWhere: (_sql: string, params?: any) => {
          if (params && 'c' in params) capturedCode = params.c;
          return qb;
        },
        getOne: async () => {
          if (fx.walletByCode && capturedCode !== undefined && capturedCode in fx.walletByCode) {
            return fx.walletByCode[capturedCode];
          }
          return fx.walletGetOne ?? null;
        },
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
    find: async () => fx.codeUsers ?? [{ id: 1 }],
    count: async () => fx.globalCodeUserCount ?? 1,
    createQueryBuilder: () => {
      const qb: any = {
        setLock: () => qb,
        select: () => qb,
        where: () => qb,
        andWhere: () => qb,
        orderBy: () => qb,
        getCount: async () => fx.foreignRefCount,
        getRawMany: async () => fx.codeCompanyIdRows ?? [],
        getMany: async () => fx.companylessUsers ?? [],
      };
      return qb;
    },
    update: async (crit: any, patch: any) => {
      cap.userUpdate.push({ crit, patch });
      return { affected: 1 };
    },
  };
  const orderRepo = {
    createQueryBuilder: () => {
      const qb: any = {
        select: () => qb,
        addSelect: () => qb,
        where: () => qb,
        andWhere: () => qb,
        orderBy: () => qb,
        limit: () => qb,
        getCount: async () => fx.outstandingCount,
        getRawMany: async () => fx.outstandingOrderRows ?? [],
      };
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
      if (e === UserCompanyEntity) {
        return { findOne: async () => (fx.companyRow !== undefined ? fx.companyRow : { id: 7 }) };
      }
      return {};
    },
  };
}

describe('SettlementCodeAdminService', () => {
  let sut: SettlementCodeAdminService;
  let userRepo: jest.Mocked<Repository<UserEntity>>;
  let billingScopeLock: { lock: jest.Mock; lockByCompany: jest.Mock };
  let activityLogService: { createLog: jest.Mock };
  let dataSource: { transaction: jest.Mock; getRepository: (e: any) => any };
  let walletLedger: { recordTransaction: jest.Mock };
  let activityLogRepo: { createQueryBuilder: jest.Mock };

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
    walletLedger = { recordTransaction: jest.fn(async () => ({ transactionId: 'tx-1', balanceAfter: 15000, isDuplicate: false })) };
    activityLogRepo = { createQueryBuilder: jest.fn() };
    fx = {
      movingUserAllSettle: 0,
      outstandingCount: 0,
      walletGetOne: null,
      issuedOwnerRows: [],
      pointsTotal: 0,
      foreignRefCount: 0,
      ensureAffected: 1,
      codeUsers: [{ id: 1 }],
      globalCodeUserCount: 1,
      codeCompanyIdRows: [{ companyId: 7 }],
      existingTx: null,
    };
    cap = { userUpdate: [], walletUpdate: [], walletSave: [], queries: [], setLockModes: [], pointWhere: [] };
    dataSource = {
      transaction: jest.fn(async (cb: (m: any) => any) => cb(makeManager(fx, cap))),
      getRepository: (e: any) => {
        if (e === WalletAccountEntity) return { findOne: async () => fx.walletGetOne };
        if (e === WalletTransactionEntity) return { findOne: async () => fx.existingTx ?? null };
        return {};
      },
    };
    sut = new SettlementCodeAdminService(
      userRepo as any,
      dataSource as any,
      billingScopeLock as unknown as BillingScopeLockService,
      activityLogService as any,
      walletLedger as any,
      activityLogRepo as any,
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
      expect(sql).toMatch(/\bowner_company_id\b/);
      expect(params).toEqual(['company-7', 7, 5000, 'POST_PAYMENT', 'CASH']);
    });
    it('settleCondition/settleMethod 인자를 wallet 정책 컬럼에 반영한다', async () => {
      const manager: any = { query: jest.fn().mockResolvedValue({ affectedRows: 1 }) };
      await sut.ensureSettlementCodeWallet(7, 'company-7', 5000, manager, 'PRE_PAYMENT', 'CARD');
      const [, params] = manager.query.mock.calls[0];
      expect(params).toEqual(['company-7', 7, 5000, 'PRE_PAYMENT', 'CARD']);
    });
    it('cardSurchargeApplied 미지정 → 컬럼을 INSERT 에서 제외해 DB 기본값(true) 적용', async () => {
      const manager: any = { query: jest.fn().mockResolvedValue({ affectedRows: 1 }) };
      await sut.ensureSettlementCodeWallet(7, 'company-7', 0, manager);
      const [sql, params] = manager.query.mock.calls[0];
      expect(sql).not.toMatch(/card_surcharge_applied/);
      expect(params).toHaveLength(5);
    });
    it('cardSurchargeApplied 지정 → 컬럼 포함 + boolean → 0/1 파라미터', async () => {
      const manager: any = { query: jest.fn().mockResolvedValue({ affectedRows: 1 }) };
      await sut.ensureSettlementCodeWallet(7, 'company-7', 0, manager, 'POST_PAYMENT', 'CARD', false);
      const [sql, params] = manager.query.mock.calls[0];
      expect(sql).toMatch(/card_surcharge_applied/);
      expect(params).toEqual(['company-7', 7, 0, 'POST_PAYMENT', 'CARD', 0]);
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

    it('target 코드가 전역에 실재하지 않으면 BadRequest (global existence, 결정 #6)', async () => {
      const moving = { id: 1, settlementCode: 'company-7', companyId: 7 };
      lockResult = { user: moving, companyUsers: [moving] };
      fx.walletGetOne = null; // target wallet 미존재
      await expect(sut.assignUserToCode(1, 'company-999')).rejects.toBeInstanceOf(BadRequestException);
      expect(cap.userUpdate).toHaveLength(0);
    });

    it('all_settle != 0 → 변경 게이트 차단', async () => {
      const moving = { id: 1, settlementCode: 'company-7', companyId: 7 };
      const other = { id: 2, settlementCode: 'company-7-1', companyId: 7 };
      lockResult = { user: moving, companyUsers: [moving, other] };
      fx.movingUserAllSettle = 15000;
      fx.walletGetOne = { id: 'w-t', depositBalance: 0, creditUsedAmount: 0, creditExcessAmount: 0 } as any; // target 실재
      await expect(sut.assignUserToCode(1, 'company-7-1')).rejects.toThrow(/미정산 외상 잔액/);
      expect(cap.userUpdate).toHaveLength(0);
    });

    it('진행 중/미정산 주문(REVIEW_COMPLETE·DELIVERY_COMPLETE-미정산 포함) → 차단', async () => {
      const moving = { id: 1, settlementCode: 'company-7', companyId: 7 };
      const other = { id: 2, settlementCode: 'company-7-1', companyId: 7 };
      lockResult = { user: moving, companyUsers: [moving, other] };
      fx.outstandingCount = 1; // 진행 중/미정산 주문 존재
      fx.walletGetOne = { id: 'w-t', depositBalance: 0, creditUsedAmount: 0, creditExcessAmount: 0 } as any; // target 실재
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

    // ── 구조화 게이트 오류 (A-4-1) ─────────────────────────────────────────
    it('all_settle != 0 → OUTSTANDING_CREDIT_BALANCE 구조화 오류(실제 잔차 포함)', async () => {
      const moving = { id: 1, settlementCode: 'company-7', companyId: 7 };
      lockResult = { user: moving, companyUsers: [moving] };
      fx.movingUserAllSettle = -3000;
      fx.walletGetOne = { id: 'w-t', depositBalance: 0, creditUsedAmount: 0, creditExcessAmount: 0 } as any;
      const err = await sut.assignUserToCode(1, 'company-7-1').catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({ code: 'OUTSTANDING_CREDIT_BALANCE', allSettleAmount: -3000 });
    });

    it('진행 중/미정산 주문 → OUTSTANDING_ORDER_EXISTS 구조화 오류(차단 주문 상태 포함)', async () => {
      const moving = { id: 1, settlementCode: 'company-7', companyId: 7 };
      lockResult = { user: moving, companyUsers: [moving] };
      fx.outstandingCount = 37;
      fx.outstandingOrderRows = [
        { id: 12345, uid: 1, status: 'DELIVERY_REQUEST', settleStatus: null },
        { id: 12344, uid: 1, status: 'DELIVERY_CONFIRMED', settleStatus: null },
      ];
      fx.walletGetOne = { id: 'w-t', depositBalance: 0, creditUsedAmount: 0, creditExcessAmount: 0 } as any;
      const err = await sut.assignUserToCode(1, 'company-7-1').catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({
        code: 'OUTSTANDING_ORDER_EXISTS',
        blockingOrderCount: 37,
        blockingOrderIds: [12345, 12344],
        blockingOrders: [
          { orderId: 12345, status: 'DELIVERY_REQUEST', settleStatus: null },
          { orderId: 12344, status: 'DELIVERY_CONFIRMED', settleStatus: null },
        ],
        blockingUserIds: [1],
      });
    });

    it('pool-orphan → SOURCE_POOL_NOT_EMPTY 구조화 오류(잔액/여신/포인트 항목)', async () => {
      const moving = { id: 1, settlementCode: 'company-7', companyId: 7 };
      lockResult = { user: moving, companyUsers: [moving] };
      fx.walletGetOne = { id: 'w-7', depositBalance: 50000, creditUsedAmount: 0, creditExcessAmount: 0 };
      const err = await sut.assignUserToCode(1, 'company-7-1').catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({
        code: 'SOURCE_POOL_NOT_EMPTY',
        settlementCode: 'company-7',
        depositBalance: 50000,
        creditUsedAmount: 0,
        creditExcessAmount: 0,
        hasPoints: false,
      });
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
      fx.globalCodeUserCount = 2; // 코드 전역 참조자 2명 → 마지막 사용자 아님
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
      // ensureSettlementCodeWallet 은 companyId + creditLimit=0 으로 INSERT.
      expect(cap.queries[0].params).toEqual(['company-7-1', 7, 0, 'PRE_PAYMENT', 'CARD']);
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

  // ── createCodeForCompany (계정 배정 없이 코드만 생성) ─────────────────────
  describe('createCodeForCompany', () => {
    it('회사 잠금 하 채번 + wallet 생성, user.settlement_code 는 건드리지 않는다', async () => {
      fx.issuedOwnerRows = [{ ownerId: 'company-7-1' }, { ownerId: 'company-7-2' }];
      const code = await sut.createCodeForCompany(7);
      expect(code).toBe('company-7-3');
      expect(billingScopeLock.lockByCompany).toHaveBeenCalledWith(7, expect.anything());
      // 정책/한도 기본값(POST_PAYMENT/CASH/creditLimit=0) + cardSurchargeApplied 미지정 → 컬럼 제외.
      expect(cap.queries[0].params).toEqual(['company-7-3', 7, 0, 'POST_PAYMENT', 'CASH']);
      expect(cap.userUpdate).toHaveLength(0);
      expect(billingScopeLock.lock).not.toHaveBeenCalled();
    });

    it('정산조건/정산방법/카드할증/여신한도를 wallet 생성과 단일 TX 로 반영한다', async () => {
      await sut.createCodeForCompany(7, {
        settleCondition: 'PRE_PAYMENT',
        settleMethod: 'CARD',
        cardSurchargeApplied: false,
        creditLimit: 5000,
      });
      expect(cap.queries).toHaveLength(1); // 생성 후 별도 정책 설정 호출 없음(원자성).
      expect(cap.queries[0].sql).toMatch(/card_surcharge_applied/);
      expect(cap.queries[0].params).toEqual(['company-7-1', 7, 5000, 'PRE_PAYMENT', 'CARD', 0]);
    });

    it('회사 미존재 → BadRequest (wallet 생성 없음)', async () => {
      fx.companyRow = null;
      await expect(sut.createCodeForCompany(999)).rejects.toBeInstanceOf(BadRequestException);
      expect(cap.queries).toHaveLength(0);
    });

    it('creditLimit 음수 → BadRequest', async () => {
      await expect(sut.createCodeForCompany(7, { creditLimit: -1 })).rejects.toBeInstanceOf(BadRequestException);
      expect(cap.queries).toHaveLength(0);
    });

    it('uq_wallet_owner 충돌 시 1회 재시도한다', async () => {
      let calls = 0;
      dataSource.transaction.mockImplementation(async (cb: any) => {
        calls += 1;
        if (calls === 1) {
          const e: any = new Error('Duplicate entry');
          e.errno = 1062;
          throw e;
        }
        return cb(makeManager(fx, cap));
      });
      expect(await sut.createCodeForCompany(7)).toBe('company-7-1');
      expect(dataSource.transaction).toHaveBeenCalledTimes(2);
    });
  });

  // ── renameCode ────────────────────────────────────────────────────────────
  describe('renameCode', () => {
    const operator = { id: 9, email: 'op@x' } as any;
    it('newCode wallet 이 이미 있으면 collision BadRequest (원자성 — update 없음)', async () => {
      fx.walletByCode = { 'company-7': { id: 'w7', ownerCompanyId: 7 }, 'company-7-new': { id: 'w-x', ownerId: 'company-7-new', ownerCompanyId: 7 } };
      await expect(sut.renameCode(7, 'company-7', 'company-7-new', operator)).rejects.toThrow(/이미 존재/);
      expect(cap.walletUpdate).toHaveLength(0);
      expect(cap.userUpdate).toHaveLength(0);
    });

    it('collision 없음 → wallet.owner_id + 모든 참조 user.settlement_code 를 한 TX 에서 갱신', async () => {
      fx.walletByCode = { 'company-7': { id: 'w7', ownerCompanyId: 7 } }; // oldCode 실재(홈 회사 7), newCode 부재
      await sut.renameCode(7, 'company-7', 'company-7-new', operator);
      expect(cap.walletUpdate).toEqual([
        { crit: { ownerType: 'SETTLEMENT_CODE', ownerId: 'company-7' }, patch: { ownerId: 'company-7-new' } },
      ]);
      expect(cap.userUpdate).toEqual([
        { crit: { companyId: 7, settlementCode: 'company-7' }, patch: { settlementCode: 'company-7-new' } },
      ]);
      // 정책/한도 이력에 리네임 감사 로그가 동일 TX 로 남는다 (settlementCode=newCode, before/after).
      expect(activityLogService.createLog).toHaveBeenCalledTimes(1);
      const [logDto, mgr] = activityLogService.createLog.mock.calls[0];
      expect(logDto).toMatchObject({
        actionType: ActivityLogActionType.SETTLE_CODE_RENAME,
        userId: 9,
        requestParams: { settlementCode: 'company-7-new', before: 'company-7', after: 'company-7-new' },
      });
      expect(mgr).toBeDefined();
    });

    it('유저 0명 코드도 rename 성공 — 소속 판정이 유저가 아니라 owner_company_id 임을 고정 (회귀 가드)', async () => {
      // 이 회사에 배정된 유저가 아예 없다(유저 기반 판정이면 "이 회사 코드 아님"으로 차단됐을 상황).
      lockByCompanyResult = { company: { id: 7 }, companyUsers: [] };
      // company-7-2 는 유저 0이지만 홈 회사(owner_company_id)가 7 → rename 허용돼야 한다.
      fx.walletByCode = { 'company-7-2': { id: 'w72', ownerCompanyId: 7 } };

      await sut.renameCode(7, 'company-7-2', 'company-7-renamed', operator);

      expect(cap.walletUpdate).toEqual([
        { crit: { ownerType: 'SETTLEMENT_CODE', ownerId: 'company-7-2' }, patch: { ownerId: 'company-7-renamed' } },
      ]);
      expect(cap.userUpdate).toEqual([
        { crit: { companyId: 7, settlementCode: 'company-7-2' }, patch: { settlementCode: 'company-7-renamed' } },
      ]);
      expect(activityLogService.createLog).toHaveBeenCalledTimes(1);
      expect(activityLogService.createLog.mock.calls[0][0]).toMatchObject({
        actionType: ActivityLogActionType.SETTLE_CODE_RENAME,
        requestParams: { settlementCode: 'company-7-renamed', before: 'company-7-2', after: 'company-7-renamed' },
      });
    });

    it('리네임 시 정책/한도 이력의 settlementCode 를 newCode 로 이관 (감사행 불변 — request_params 만 targeted UPDATE)', async () => {
      fx.walletByCode = { 'company-7': { id: 'w7', ownerCompanyId: 7 } };

      await sut.renameCode(7, 'company-7', 'company-7-new', operator);

      const migration = cap.queries.find((q) => /UPDATE\s+activity_log/i.test(q.sql));
      expect(migration).toBeDefined();
      // request_params 만 SET (전 컬럼 재기록 금지 — updated_at 등 다른 컬럼은 SET 절에 없음)
      expect(migration!.sql).toMatch(/SET\s+request_params\s*=\s*JSON_SET\(request_params, '\$\.settlementCode', \?\)/);
      expect(migration!.sql).not.toMatch(/updated_at/);
      // 소프트삭제 제외 + action_type 3종 스코프 + oldCode → newCode 치환
      expect(migration!.sql).toMatch(/deleted_at IS NULL/);
      expect(migration!.sql).toMatch(/action_type IN \(\?, \?, \?\)/);
      expect(migration!.sql).toMatch(/JSON_UNQUOTE\(JSON_EXTRACT\(request_params, '\$\.settlementCode'\)\) = \?/);
      expect(migration!.params).toEqual([
        'company-7-new',
        ActivityLogActionType.MAXIMUM_LIMIT_MODIFY,
        ActivityLogActionType.SETTLE_CODE_POLICY_MODIFY,
        ActivityLogActionType.SETTLE_CODE_RENAME,
        'company-7',
      ]);
    });

    it('oldCode 의 홈 회사(owner_company_id)가 이 회사가 아니면 BadRequest (타 회사 code 전역 rename 방지)', async () => {
      // company-999 wallet 은 존재하나 홈 회사가 999 → companyId=7 로는 rename 불가(유저 유무와 무관).
      fx.walletByCode = { 'company-999': { id: 'w999', ownerCompanyId: 999 } };
      await expect(sut.renameCode(7, 'company-999', 'company-999-new', operator)).rejects.toThrow(/속한 코드가 아닙니다/);
      expect(cap.walletUpdate).toHaveLength(0);
      expect(cap.userUpdate).toHaveLength(0);
    });

    it('oldCode 가 다른 회사와 공유 중이면 BadRequest (공유 코드 리네임 불가 계약, 결정 #6)', async () => {
      // 이 회사 소속 검증은 통과하나, 타 회사 공유 참조가 있어 리네임 불가(단일 회사 전용 코드만 허용).
      fx.foreignRefCount = 1;
      fx.walletByCode = { 'company-7': { id: 'w7', ownerCompanyId: 7 } }; // oldCode 실재(홈 회사 7)
      await expect(sut.renameCode(7, 'company-7', 'company-7-new', operator)).rejects.toThrow(/공유 중이라 리네임할 수 없습니다/);
      expect(cap.walletUpdate).toHaveLength(0);
      expect(cap.userUpdate).toHaveLength(0);
    });

    it('oldCode wallet 부재(dangling) → BadRequest (assign 인터리빙 대비 FOR UPDATE 확보)', async () => {
      fx.walletByCode = {}; // oldCode wallet 없음
      fx.walletGetOne = null;
      await expect(sut.renameCode(7, 'company-7', 'company-7-new', operator)).rejects.toThrow(/wallet_account 를 찾을 수 없습니다/);
      expect(cap.walletUpdate).toHaveLength(0);
      expect(cap.userUpdate).toHaveLength(0);
    });

    it('oldCode == newCode → BadRequest', async () => {
      await expect(sut.renameCode(7, 'company-7', 'company-7', operator)).rejects.toBeInstanceOf(BadRequestException);
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
      expect(r).toEqual({ settlementCode: 'company-7', before: 5000, after: 20000, belowCurrentUsage: false });
      expect(cap.setLockModes).toContain('pessimistic_write');
      expect(cap.walletSave[0]).toEqual(expect.objectContaining({ creditLimit: 20000 }));
      // createLog 는 (dto, manager) 2인자로 호출 — 동일 트랜잭션 감사.
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
        expect.anything(),
      );
    });

    it('creditLimit < 현재 사용액 → belowCurrentUsage: true (사용액 불변, 설정은 허용)', async () => {
      fx.walletGetOne = { id: 'w-7', ownerId: 'company-7', creditLimit: 50000, creditUsedAmount: 30000 };
      const r = await sut.setCodeCreditLimit('company-7', 20000, operator);
      expect(r).toEqual({ settlementCode: 'company-7', before: 50000, after: 20000, belowCurrentUsage: true });
      expect(cap.walletSave[0]).toEqual(expect.objectContaining({ creditLimit: 20000, creditUsedAmount: 30000 }));
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

  // ── setSettlePolicy (PR-A) ────────────────────────────────────────────────
  describe('setSettlePolicy', () => {
    it('변경 항목 없음 → BadRequest', async () => {
      await expect(sut.setSettlePolicy('company-7', {}, { id: 9, email: 'op@x' } as any)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('wallet 없음 → BadRequest', async () => {
      fx.walletGetOne = null;
      await expect(
        sut.setSettlePolicy('company-7', { settleMethod: 'CARD' }, { id: 9, email: 'op@x' } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('정산방법만 변경 → 게이트 없이 저장 + activity_log', async () => {
      fx.walletGetOne = { id: 'w1', settleCondition: 'POST_PAYMENT', settleMethod: 'CASH' } as any;
      const res = await sut.setSettlePolicy('company-7', { settleMethod: 'CARD' }, { id: 9, email: 'op@x' } as any);
      expect(res.after.settleMethod).toBe('CARD');
      expect(cap.walletSave[0].settleMethod).toBe('CARD');
      expect(activityLogService.createLog).toHaveBeenCalledTimes(1);
    });

    it('카드할증 기본값 변경 → 저장 + before/after activity_log', async () => {
      fx.walletGetOne = {
        id: 'w1',
        settleCondition: 'POST_PAYMENT',
        settleMethod: 'CARD',
        cardSurchargeApplied: true,
      } as any;

      const res = await sut.setSettlePolicy(
        'company-7',
        { cardSurchargeApplied: false },
        { id: 9, email: 'op@x' } as any,
      );

      expect(res.before.cardSurchargeApplied).toBe(true);
      expect(res.after.cardSurchargeApplied).toBe(false);
      expect(cap.walletSave[0].cardSurchargeApplied).toBe(false);
      expect(activityLogService.createLog).toHaveBeenCalledWith(
        expect.objectContaining({
          requestParams: expect.objectContaining({
            before: expect.objectContaining({ cardSurchargeApplied: true }),
            after: expect.objectContaining({ cardSurchargeApplied: false }),
          }),
        }),
        expect.anything(),
      );
    });

    it('카드할증 기본값이 현재값과 동일 → no-op', async () => {
      fx.walletGetOne = {
        id: 'w1',
        settleCondition: 'POST_PAYMENT',
        settleMethod: 'CARD',
        cardSurchargeApplied: false,
      } as any;

      const res = await sut.setSettlePolicy(
        'company-7',
        { cardSurchargeApplied: false },
        { id: 9, email: 'op@x' } as any,
      );

      expect(res.noop).toBe(true);
      expect(cap.walletSave).toHaveLength(0);
      expect(activityLogService.createLog).not.toHaveBeenCalled();
    });

    it('정산조건 변경 + 진행중 주문 있음 → 구조화된 게이트 차단(BadRequest, blocking ids 포함)', async () => {
      fx.walletGetOne = { id: 'w1', settleCondition: 'POST_PAYMENT', settleMethod: 'CASH' } as any;
      fx.codeUsers = [{ id: 1 }];
      fx.outstandingCount = 3; // 전체 차단 주문 수(집계)
      fx.outstandingOrderRows = [{ id: 101, uid: 1 }]; // 대표 주문/uid
      let caught: any;
      await sut
        .setSettlePolicy('company-7', { settleCondition: 'PRE_PAYMENT' }, { id: 9, email: 'op@x' } as any)
        .catch((e) => (caught = e));
      expect(caught).toBeInstanceOf(BadRequestException);
      expect(caught.getResponse()).toEqual(
        expect.objectContaining({
          code: 'OUTSTANDING_ORDER_EXISTS',
          blockingUserIds: [1],
          blockingOrderCount: 3,
          blockingOrderIds: [101],
        }),
      );
      expect(cap.walletSave).toHaveLength(0);
    });

    it('요청값이 현재값과 동일 → no-op(저장/activity_log 없음, noop:true)', async () => {
      fx.walletGetOne = { id: 'w1', settleCondition: 'POST_PAYMENT', settleMethod: 'CASH' } as any;
      const res = await sut.setSettlePolicy(
        'company-7',
        { settleCondition: 'POST_PAYMENT', settleMethod: 'CASH' },
        { id: 9, email: 'op@x' } as any,
      );
      expect(res.noop).toBe(true);
      expect(cap.walletSave).toHaveLength(0);
      expect(activityLogService.createLog).not.toHaveBeenCalled();
    });

    it('정산조건 변경 + 진행중 주문 없음 → 저장', async () => {
      fx.walletGetOne = { id: 'w1', settleCondition: 'POST_PAYMENT', settleMethod: 'CASH' } as any;
      fx.codeUsers = [{ id: 1 }];
      fx.outstandingCount = 0;
      const res = await sut.setSettlePolicy(
        'company-7',
        { settleCondition: 'PRE_PAYMENT' },
        { id: 9, email: 'op@x' } as any,
      );
      expect(res.after.settleCondition).toBe('PRE_PAYMENT');
      expect(cap.walletSave[0].settleCondition).toBe('PRE_PAYMENT');
    });

    it('정산조건 변경 → 코드 참조 회사를 회사 ASC로 잠근 뒤 재검증 (P1 직렬화)', async () => {
      fx.walletGetOne = { id: 'w1', settleCondition: 'POST_PAYMENT', settleMethod: 'CASH' } as any;
      fx.codeCompanyIdRows = [{ companyId: 3 }, { companyId: 7 }];
      fx.outstandingCount = 0;
      await sut.setSettlePolicy('company-7', { settleCondition: 'PRE_PAYMENT' }, { id: 9, email: 'op@x' } as any);
      expect(billingScopeLock.lockByCompany).toHaveBeenCalledTimes(2);
      expect(billingScopeLock.lockByCompany.mock.calls.map((c) => c[0])).toEqual([3, 7]);
    });

    it('정산방법만 변경 → 회사 락 없음(게이트 미적용)', async () => {
      fx.walletGetOne = { id: 'w1', settleCondition: 'POST_PAYMENT', settleMethod: 'CASH' } as any;
      await sut.setSettlePolicy('company-7', { settleMethod: 'CARD' }, { id: 9, email: 'op@x' } as any);
      expect(billingScopeLock.lockByCompany).not.toHaveBeenCalled();
    });

    it('정산조건 변경 → 회사미연결 계정만 있어도 잠그고 재검증 후 저장', async () => {
      fx.walletGetOne = { id: 'w1', settleCondition: 'POST_PAYMENT', settleMethod: 'CASH' } as any;
      fx.codeCompanyIdRows = []; // 회사 없음
      fx.companylessUsers = [{ id: 5 }];
      fx.codeUsers = [{ id: 5 }];
      fx.outstandingCount = 0;
      const res = await sut.setSettlePolicy(
        'company-x',
        { settleCondition: 'PRE_PAYMENT' },
        { id: 9, email: 'op@x' } as any,
      );
      expect(res.after.settleCondition).toBe('PRE_PAYMENT');
      expect(billingScopeLock.lockByCompany).not.toHaveBeenCalled(); // 회사 없음 → 회사 락 없이 회사미연결 유저만 잠금
    });
  });

  // ── chargeDeposit (PR-A) ──────────────────────────────────────────────────
  describe('chargeDeposit', () => {
    it('금액 0 이하 → BadRequest', async () => {
      await expect(
        sut.chargeDeposit('company-7', 0, { id: 9, email: 'op@x' } as any, undefined, 'req-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('requestKey 없음 → BadRequest', async () => {
      fx.walletGetOne = { id: 'w1' } as any;
      await expect(
        sut.chargeDeposit('company-7', 5000, { id: 9, email: 'op@x' } as any, undefined, '  '),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('wallet 없음 → BadRequest', async () => {
      fx.walletGetOne = null;
      await expect(
        sut.chargeDeposit('company-7', 1000, { id: 9, email: 'op@x' } as any, undefined, 'req-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('충전 성공 → DEPOSIT +amount 원장 기록(운영자/메모/멱등키) + balanceAfter 반환', async () => {
      fx.walletGetOne = { id: 'w1' } as any;
      const res = await sut.chargeDeposit('company-7', 5000, { id: 9, email: 'op@x' } as any, '메모', 'req-1');
      const arg = walletLedger.recordTransaction.mock.calls[0][0];
      expect(arg.resourceType).toBe('DEPOSIT');
      expect(arg.amount).toBe(5000);
      expect(arg.type).toBe('CHARGE');
      // 감사 정본 payload: 운영자/메모/멱등키가 원장에 보존되어야 한다.
      expect(arg.operatorId).toBe(9);
      expect(arg.operatorEmail).toBe('op@x');
      expect(arg.memo).toBe('메모');
      expect(typeof arg.idempotencyKey).toBe('string');
      expect(arg.idempotencyKey).toMatch(/^ADMIN_DEPOSIT:/);
      expect(res.depositBalanceAfter).toBe(15000);
      expect(res.isDuplicate).toBe(false);
      expect(activityLogService.createLog).toHaveBeenCalledTimes(1);
    });

    it('activity_log 실패해도 충전은 성공 반환 (원장 정본, 로그 best-effort)', async () => {
      fx.walletGetOne = { id: 'w1' } as any;
      activityLogService.createLog.mockRejectedValueOnce(new Error('activity_log down'));
      const res = await sut.chargeDeposit('company-7', 5000, { id: 9, email: 'op@x' } as any, undefined, 'req-1');
      expect(res.isDuplicate).toBe(false);
      expect(res.depositBalanceAfter).toBe(15000);
      expect(walletLedger.recordTransaction).toHaveBeenCalledTimes(1);
    });

    it('동일 requestKey·다른 금액 → 409(Conflict)', async () => {
      fx.walletGetOne = { id: 'w1' } as any;
      fx.existingTx = { amount: 10000, balanceAfter: 10000 };
      await expect(
        sut.chargeDeposit('company-7', 1000000, { id: 9, email: 'op@x' } as any, undefined, 'req-1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(walletLedger.recordTransaction).not.toHaveBeenCalled();
    });

    it('동일 requestKey·같은 금액 재시도 → 최초 원장 사실 반환, 신규 이력 미기록', async () => {
      fx.walletGetOne = { id: 'w1' } as any;
      fx.existingTx = { amount: 5000, balanceAfter: 15000 };
      const res = await sut.chargeDeposit('company-7', 5000, { id: 9, email: 'op@x' } as any, undefined, 'req-1');
      expect(res).toEqual({ settlementCode: 'company-7', charged: 5000, depositBalanceAfter: 15000, isDuplicate: true });
      expect(walletLedger.recordTransaction).not.toHaveBeenCalled();
      expect(activityLogService.createLog).not.toHaveBeenCalled();
    });
  });

  // ── assignUserToCode 교차 회사 허용 (PR-A, 결정 #6) ────────────────────────
  describe('assignUserToCode cross-company', () => {
    it('target wallet 실재 → 교차 회사 코드로 배정 허용', async () => {
      lockResult = {
        user: { id: 1, settlementCode: 'company-5', companyId: 5 },
        companyUsers: [{ id: 1, settlementCode: 'company-5' }],
      };
      fx.walletGetOne = { id: 'w99', depositBalance: 0, creditUsedAmount: 0, creditExcessAmount: 0 } as any;
      fx.pointsTotal = 0;
      await sut.assignUserToCode(1, 'company-99');
      expect(cap.userUpdate[0].patch).toEqual({ settlementCode: 'company-99' });
    });

    it('target wallet 없음 → BadRequest (전역 미실재)', async () => {
      lockResult = {
        user: { id: 1, settlementCode: 'company-5', companyId: 5 },
        companyUsers: [{ id: 1, settlementCode: 'company-5' }],
      };
      fx.walletGetOne = null;
      await expect(sut.assignUserToCode(1, 'company-99')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ── getCodeHistory (정책/한도, activity_log) ───────────────────────────────
  describe('getCodeHistory', () => {
    function makeHistoryQb(rows: any[], cap?: { andWhere: any[][]; limit: number[] }) {
      const qb: any = {
        where: () => qb,
        andWhere: (...args: any[]) => {
          cap?.andWhere.push(args);
          return qb;
        },
        orderBy: () => qb,
        addOrderBy: () => qb,
        limit: (n: number) => {
          cap?.limit.push(n);
          return qb;
        },
        getMany: async () => rows,
      };
      return qb;
    }

    it('잘못된 eventType(DEPOSIT_CHARGED) → BadRequest', async () => {
      await expect(sut.getCodeHistory('company-7', { eventType: 'DEPOSIT_CHARGED' as any })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('잘못된 cursor → BadRequest (DB 접근 전)', async () => {
      await expect(sut.getCodeHistory('company-7', { cursor: 'not-a-valid-cursor!!' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('유효 JSON 이지만 id 가 정수 문자열이 아니면 → BadRequest', async () => {
      const bad = Buffer.from(JSON.stringify({ id: 'abc' })).toString('base64url');
      await expect(sut.getCodeHistory('company-7', { cursor: bad })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('id=0 cursor → BadRequest (양의 정수만 허용)', async () => {
      const bad = Buffer.from(JSON.stringify({ id: '0' })).toString('base64url');
      await expect(sut.getCodeHistory('company-7', { cursor: bad })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('정책/한도 이력 매핑 + nextCursor(limit 초과 시)', async () => {
      const rows = [
        {
          id: 20,
          actionType: ActivityLogActionType.SETTLE_CODE_POLICY_MODIFY,
          userId: 9,
          userEmail: 'op@x',
          requestParams: { settlementCode: 'company-7', before: { settleMethod: 'CASH' }, after: { settleMethod: 'CARD' } },
          createdAt: new Date('2026-07-10T00:00:00.000Z'),
        },
        {
          id: 10,
          actionType: ActivityLogActionType.MAXIMUM_LIMIT_MODIFY,
          userId: 9,
          userEmail: 'op@x',
          requestParams: { settlementCode: 'company-7', beforeMaximumLimit: 1000, afterMaximumLimit: 2000 },
          createdAt: new Date('2026-07-09T00:00:00.000Z'),
        },
      ];
      activityLogRepo.createQueryBuilder.mockReturnValue(makeHistoryQb(rows));
      const page = await sut.getCodeHistory('company-7', { limit: 1 });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({
        source: 'ACTIVITY_LOG',
        eventType: 'SETTLE_POLICY_CHANGED',
        sourceId: '20',
        operatorId: 9,
      });
      expect(page.nextCursor).not.toBeNull();
      const decoded = JSON.parse(Buffer.from(page.nextCursor as string, 'base64url').toString('utf8'));
      expect(decoded.id).toBe('20');
    });

    it('리네임 이력을 CODE_RENAMED 로 매핑 (before=oldCode, after=newCode)', async () => {
      const rows = [
        {
          id: 30,
          actionType: ActivityLogActionType.SETTLE_CODE_RENAME,
          userId: 9,
          userEmail: 'op@x',
          requestParams: { settlementCode: 'company-7-new', before: 'company-7', after: 'company-7-new' },
          createdAt: new Date('2026-07-11T00:00:00.000Z'),
        },
      ];
      activityLogRepo.createQueryBuilder.mockReturnValue(makeHistoryQb(rows));
      const page = await sut.getCodeHistory('company-7-new');
      expect(page.items[0]).toMatchObject({
        source: 'ACTIVITY_LOG',
        eventType: 'CODE_RENAMED',
        sourceId: '30',
        operatorId: 9,
        before: 'company-7',
        after: 'company-7-new',
      });
    });

    it('eventType=CODE_RENAMED → SETTLE_CODE_RENAME 단일 타입으로 필터', async () => {
      const cap = { andWhere: [] as any[][], limit: [] as number[] };
      const qb = makeHistoryQb([], cap);
      let capturedTypes: any;
      qb.andWhere = (sql: string, params?: any) => {
        if (params && 'types' in params) capturedTypes = params.types;
        cap.andWhere.push([sql, params]);
        return qb;
      };
      activityLogRepo.createQueryBuilder.mockReturnValue(qb);
      await sut.getCodeHistory('company-7-new', { eventType: 'CODE_RENAMED' });
      expect(capturedTypes).toEqual([ActivityLogActionType.SETTLE_CODE_RENAME]);
    });

    it('유효 cursor → id 비교 조건 + limit(limit+1) 적용', async () => {
      const cap = { andWhere: [] as any[][], limit: [] as number[] };
      activityLogRepo.createQueryBuilder.mockReturnValue(makeHistoryQb([], cap));
      const cursor = Buffer.from(JSON.stringify({ id: '20' })).toString('base64url');
      await sut.getCodeHistory('company-7', { limit: 10, cursor });
      // limit + 1 (다음 페이지 존재 판정용)
      expect(cap.limit).toContain(11);
      // cursor 비교 andWhere 가 id 파라미터와 함께 적용됨(단일 테이블 id DESC)
      const cursorClause = cap.andWhere.find((a) => typeof a[0] === 'string' && a[0].includes('a.id < :cId'));
      expect(cursorClause).toBeDefined();
      expect(cursorClause![1]).toEqual({ cId: 20 });
    });
  });

  // ── getDepositHistory (예치금, wallet_transaction 정본) ─────────────────────
  describe('getDepositHistory', () => {
    it('wallet 없음 → BadRequest', async () => {
      (dataSource as any).getRepository = (e: any) =>
        e === WalletAccountEntity ? { findOne: async () => null } : {};
      await expect(sut.getDepositHistory('company-7')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('예치금 이력을 wallet_transaction 정본에서 DEPOSIT_CHARGED 로 매핑', async () => {
      const tx = {
        id: '77',
        createdAt: new Date('2026-07-11T00:00:00.000Z'),
        operatorId: 9,
        operatorEmail: 'op@x',
        balanceBefore: 1000,
        balanceAfter: 6000,
        memo: '충전',
      };
      const qb: any = {
        where: () => qb,
        andWhere: () => qb,
        orderBy: () => qb,
        addOrderBy: () => qb,
        limit: () => qb,
        getMany: async () => [tx],
      };
      (dataSource as any).getRepository = (e: any) => {
        if (e === WalletAccountEntity) return { findOne: async () => ({ id: 'w1' }) };
        if (e === WalletTransactionEntity) return { createQueryBuilder: () => qb };
        return {};
      };
      const page = await sut.getDepositHistory('company-7', { limit: 50 });
      expect(page.items[0]).toMatchObject({
        source: 'WALLET_TRANSACTION',
        eventType: 'DEPOSIT_CHARGED',
        sourceId: '77',
        operatorId: 9,
        before: 1000,
        after: 6000,
      });
      expect(page.nextCursor).toBeNull();
    });
  });
});
