import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, EntityManager, Repository } from 'typeorm';
import { UserEntity } from '../../entity/user.entity';
import { WalletAccountEntity } from '../../entity/wallet.account.entity';
import { PointGrantEntity } from '../../entity/point.grant.entity';
import { OrderEntity } from '../../entity/order.entity';
import { IOrderStatus } from '../../order/interface/order.status';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { ActivityLogService } from '../../activity_log/application/activity.log.service';
import { ActivityLogActionType } from '../../activity_log/interface/activity.log.action.type';
import { ActivityLogResult } from '../../activity_log/interface/activity.log.result';
import { BillingScopeLockService } from './billing-scope-lock.service';

export type SettlementJoinMode = 'NEW' | 'SHARE_ONE' | 'PENDING';

export interface SettlementJoinClassification {
  mode: SettlementJoinMode;
  code?: string;
}

const SETTLE_COMPLETE = 'SETTLE_COMPLETE';

/** 진행 중(변경 차단) 판정 대상 상태. TEMP/DELIVERY_CANCEL 은 제외. */
const CHANGE_GATE_INFLIGHT_STATUSES: IOrderStatus[] = [
  IOrderStatus.DELIVERY_REQUEST,
  IOrderStatus.REVIEW_COMPLETE,
  IOrderStatus.DELIVERY_CONFIRMED,
];

/**
 * settlement_code 프로비저닝 / 운영자 관리 서비스.
 *
 * PR-A 범위: 계정 생성 시 조건부 code 배정 + 공유 wallet 프로비저닝 (ensureSettlementCodeWallet / classifyJoin).
 * PR-C 범위: 운영자 mutation (assignUserToCode / issueNewCode / renameCode / setCodeCreditLimit).
 *
 * 모든 mutation 은 BillingScopeLock(회사 row FOR UPDATE → 사용자 id-ASC) 표준 잠금 순서를 재사용하고,
 * 이어 SOURCE wallet 을 FOR UPDATE NOWAIT 로 잠근 뒤 풀 잔액을 읽는다 (H2 TOCTOU 방지, 회사→사용자→wallet 순서 유지).
 * assign/issue 는 변경 게이트(진행 중 주문 없음 + 마지막 사용자 orphan-풀 안전)를 통과해야만 code field 만 갱신한다
 * (자금 이동 없음 — pooled 모델에서 code 변경은 자금-중립).
 */
@Injectable()
export class SettlementCodeAdminService {
  private readonly logger = new Logger(SettlementCodeAdminService.name);

  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly billingScopeLock: BillingScopeLockService,
    private readonly activityLogService: ActivityLogService,
  ) {}

  /**
   * settlement_code 단위 공유 wallet_account 를 멱등 생성한다.
   *
   * INSERT ... ON DUPLICATE KEY UPDATE id=id (uq_wallet_owner) 로, 동일 code 가 이미 있으면
   * no-op 성공 처리한다 (동시 가입 race 에서도 단일 row 보장 — Pre-mortem #2). 중복은 log.warn.
   *
   * @param companyId 로그/추적용 (실제 wallet 은 code 로 식별; wallet 에 company_id 컬럼 없음).
   * @param code      owner_id (예: company-123).
   * @param creditLimit 신규 생성 시 여신 한도.
   * @param manager   호출자가 소유한 트랜잭션 매니저 (필수 — 프로비저닝은 호스트 TX 안에서 실행).
   */
  async ensureSettlementCodeWallet(
    companyId: number,
    code: string,
    creditLimit: number,
    manager: EntityManager,
    settleCondition: 'PRE_PAYMENT' | 'POST_PAYMENT' = 'POST_PAYMENT',
    settleMethod: 'CARD' | 'CASH' = 'CASH',
  ): Promise<void> {
    const result = await manager.query(
      `INSERT INTO wallet_account
         (owner_type, owner_id, deposit_balance, credit_limit, credit_used_amount, credit_excess_amount, settle_condition, settle_method)
       VALUES ('SETTLEMENT_CODE', ?, 0, ?, 0, 0, ?, ?)
       ON DUPLICATE KEY UPDATE id = id`,
      [code, creditLimit, settleCondition, settleMethod],
    );

    // MySQL: 신규 insert 는 affectedRows=1, id=id no-op update(중복) 는 affectedRows=0.
    const affectedRows = (result as { affectedRows?: number })?.affectedRows;
    if (affectedRows === 0) {
      this.logger.warn(`settlement_code wallet already exists — skip create (companyId=${companyId}, code=${code})`);
    }
  }

  /**
   * 가입/생성 시 settlement_code 배정 모드를 판정한다 (S4).
   *
   * - companyId 없음(사업자번호 없음) → PENDING (code 없음, 'company-null' 금지).
   * - isNewCompany(이번 호출에서 회사 row 신규 생성) → NEW: company-{id}.
   * - 기존 회사: 소속 사용자의 DISTINCT NON-EMPTY settlement_code (''/NULL 제외) 개수가
   *   정확히 1 → SHARE_ONE(그 code 공유); 0 또는 2 이상 → PENDING (운영자 배정 대기).
   */
  async classifyJoin(
    companyId: number | null,
    isNewCompany: boolean,
    manager?: EntityManager,
  ): Promise<SettlementJoinClassification> {
    if (companyId == null) {
      return { mode: 'PENDING' };
    }
    if (isNewCompany) {
      return { mode: 'NEW', code: `company-${companyId}` };
    }

    const userRepo = manager ? manager.getRepository(UserEntity) : this.userRepository;
    const rows = await userRepo
      .createQueryBuilder('u')
      .select('DISTINCT u.settlementCode', 'code')
      .where('u.companyId = :companyId', { companyId })
      .andWhere('u.settlementCode IS NOT NULL')
      .andWhere("u.settlementCode != ''")
      .getRawMany<{ code: string | null }>();

    const codes = rows.map((r) => r.code).filter((c): c is string => c != null && c !== '');

    if (codes.length === 1) {
      return { mode: 'SHARE_ONE', code: codes[0] };
    }
    return { mode: 'PENDING' };
  }

  /**
   * 운영자: 정산코드 배정 대기(PENDING) 계정 목록을 조회한다.
   *
   * 회사 소속 활성 사용자(deleted_at IS NULL) 중 settlement_code 가 ''/NULL 인 계정을 반환한다.
   * GET /settlement-codes 는 non-empty code 만 노출하므로(distinctSettlementCodes) 배정 전 계정을
   * 발견하려면 이 목록이 필요하다 (assign/issue 대상 후보).
   */
  async listPendingAccounts(
    companyId: number,
  ): Promise<{ companyId: number; pendingUsers: { userId: number; personName: string }[] }> {
    const rows = await this.userRepository
      .createQueryBuilder('u')
      .select('u.id', 'userId')
      .addSelect('u.personName', 'personName')
      .where('u.companyId = :companyId', { companyId })
      .andWhere('u.deletedAt IS NULL')
      .andWhere("u.status != 'LEAVE'")
      .andWhere(
        new Brackets((qb) => {
          qb.where('u.settlementCode IS NULL').orWhere("u.settlementCode = ''");
        }),
      )
      .getRawMany<{ userId: number; personName: string }>();

    return {
      companyId,
      pendingUsers: rows.map((r) => ({ userId: Number(r.userId), personName: r.personName })),
    };
  }

  /**
   * 운영자: 사용자를 회사의 기존 정산코드로 재배정한다 (자금 이동 없음).
   *
   * BillingScopeLock(userId) → SOURCE wallet FOR UPDATE NOWAIT → 변경 게이트 → code field 갱신.
   * targetCode 는 계정 소속 회사의 기존 DISTINCT 코드여야 한다.
   */
  async assignUserToCode(userId: number, targetCode: string): Promise<void> {
    if (!targetCode || targetCode.trim() === '') {
      throw new BadRequestException('대상 정산코드(targetCode)가 비어 있습니다.');
    }
    await this.runWithRetry(() =>
      this.dataSource.transaction(async (manager) => {
        const { user, companyUsers } = await this.billingScopeLock.lock(userId, manager);

        // targetCode 는 이 회사의 기존 DISTINCT NON-EMPTY 코드여야 한다.
        const existingCodes = new Set(companyUsers.map((u) => u.settlementCode).filter((c) => c != null && c !== ''));
        if (!existingCodes.has(targetCode)) {
          throw new BadRequestException(
            `대상 정산코드('${targetCode}')는 이 회사의 기존 정산코드가 아닙니다. (issue 로 신규 발급하거나 기존 코드를 지정하세요.)`,
          );
        }

        const sourceCode = user.settlementCode ?? '';
        if (sourceCode === targetCode) {
          return; // 이미 해당 코드 — no-op.
        }

        await this.assertChangeGate(manager, companyUsers, userId, sourceCode);
        await manager.getRepository(UserEntity).update({ id: userId }, { settlementCode: targetCode });
        this.logger.log(`assignUserToCode userId=${userId} ${sourceCode || '(none)'} -> ${targetCode}`);
      }),
    );
  }

  /**
   * 운영자: 사용자에게 신규 정산코드 풀을 발급한다 (company-{id}-{n}).
   *
   * BillingScopeLock 의 회사 row FOR UPDATE 가 같은 회사의 동시 발급을 직렬화하므로 n 이 race-safe.
   * ensureSettlementCodeWallet(creditLimit=0) + user.settlement_code 갱신을 단일 TX 로 처리.
   * uq_wallet_owner 충돌 시 1회 재시도 (n 재계산).
   */
  async issueNewCode(userId: number): Promise<string> {
    return this.runWithRetry(() =>
      this.dataSource.transaction(async (manager) => {
        const { user, companyUsers } = await this.billingScopeLock.lock(userId, manager);
        const companyId = user.companyId;
        if (companyId == null) {
          throw new BadRequestException('회사가 연결되지 않은 계정은 정산코드를 발급할 수 없습니다.');
        }

        const sourceCode = user.settlementCode ?? '';
        await this.assertChangeGate(manager, companyUsers, userId, sourceCode);

        const newCode = await this.nextIssuedCode(manager, companyId);
        await this.ensureSettlementCodeWallet(companyId, newCode, 0, manager, user.settleCondition, user.settleMethod);
        await manager.getRepository(UserEntity).update({ id: userId }, { settlementCode: newCode });
        this.logger.log(`issueNewCode userId=${userId} ${sourceCode || '(none)'} -> ${newCode}`);
        return newCode;
      }),
    );
  }

  /**
   * 운영자: 정산코드를 리네임한다 (wallet_account.owner_id + 모든 참조 user.settlement_code 일괄 갱신).
   *
   * wallet_account.id(allocation/wallet_transaction 참조 PK)는 유지되므로 자금/원장 참조 안전.
   * 진행 중 주문과 무관하게 언제든 가능 (자금 이동 없음). oldCode 는 회사 소속 검증(회사→users 잠금 하),
   * newCode 는 잠금 하 사전 부재 검증.
   */
  async renameCode(companyId: number, oldCode: string, newCode: string): Promise<void> {
    if (!oldCode || !newCode) {
      throw new BadRequestException('oldCode / newCode 는 필수입니다.');
    }
    if (oldCode === newCode) {
      throw new BadRequestException('oldCode 와 newCode 가 동일합니다.');
    }
    await this.dataSource.transaction(async (manager) => {
      // 회사 → users 순으로 잠근 뒤 oldCode 가 이 회사 소속 코드인지 검증 (타 회사 코드 전역 rename 방지, H5).
      const { companyUsers } = await this.billingScopeLock.lockByCompany(companyId, manager);
      const belongsToCompany = companyUsers.some((u) => u.settlementCode === oldCode);
      if (!belongsToCompany) {
        throw new BadRequestException(
          `정산코드('${oldCode}')는 이 회사(companyId=${companyId})에 속한 코드가 아닙니다.`,
        );
      }

      // oldCode 가 타 회사(또는 회사미연결) 사용자에서도 참조되면(legacy/drift), wallet owner_id 는 전역 rename 되지만
      // 그들의 settlement_code 는 남아 wallet 없는 code 를 참조하게 된다 → fail-closed 차단 (수동 정합성 정리 유도).
      const foreignRefCount = await manager
        .getRepository(UserEntity)
        .createQueryBuilder('u')
        .where('u.settlementCode = :oldCode', { oldCode })
        .andWhere('(u.companyId != :companyId OR u.companyId IS NULL)', { companyId })
        .getCount();
      if (foreignRefCount > 0) {
        throw new BadRequestException(
          `정산코드('${oldCode}')가 타 회사(또는 회사미연결) 사용자에서도 참조됩니다. 데이터 정합성 확인 후 처리하세요.`,
        );
      }

      const collision = await this.lockWalletByCode(manager, newCode, 'pessimistic_write');
      if (collision) {
        throw new BadRequestException(`정산코드('${newCode}')가 이미 존재합니다. 리네임 대상으로 사용할 수 없습니다.`);
      }

      await manager
        .getRepository(WalletAccountEntity)
        .update({ ownerType: 'SETTLEMENT_CODE', ownerId: oldCode }, { ownerId: newCode });
      await manager
        .getRepository(UserEntity)
        .update({ companyId, settlementCode: oldCode }, { settlementCode: newCode });
      this.logger.log(`renameCode companyId=${companyId} ${oldCode} -> ${newCode}`);
    });
  }

  /**
   * 운영자: 정산코드 단위 wallet.creditLimit(여신 한도 SoT)를 설정한다 (S9).
   *
   * wallet FOR UPDATE + creditLimit>=0 검증 + activity_log(운영자 id/email, settlementCode, before/after)
   * — modifyMaximumLimit 감사와 동일 형식.
   */
  async setCodeCreditLimit(
    settlementCode: string,
    creditLimit: number,
    operator: ILoginUserInfo,
  ): Promise<{ settlementCode: string; before: number; after: number }> {
    if (!Number.isInteger(creditLimit) || creditLimit < 0) {
      throw new BadRequestException('여신 한도(creditLimit)는 0 이상의 정수여야 합니다.');
    }
    return this.dataSource.transaction(async (manager) => {
      const wallet = await this.lockWalletByCode(manager, settlementCode, 'pessimistic_write');
      if (!wallet) {
        throw new BadRequestException(`정산코드('${settlementCode}') 의 wallet_account 를 찾을 수 없습니다.`);
      }

      const before = wallet.creditLimit;
      wallet.creditLimit = creditLimit;
      await manager.getRepository(WalletAccountEntity).save(wallet);

      await this.activityLogService.createLog({
        userId: operator.id,
        userEmail: operator.email,
        method: 'PUT',
        requestUrl: '/settlement-codes/credit-limit',
        actionType: ActivityLogActionType.MAXIMUM_LIMIT_MODIFY,
        ipAddress: '',
        statusCode: 200,
        result: ActivityLogResult.SUCCESS,
        responseTime: 0,
        requestParams: {
          settlementCode,
          beforeMaximumLimit: before,
          afterMaximumLimit: creditLimit,
        },
      });

      this.logger.log(
        `setCodeCreditLimit code=${settlementCode} ${before} -> ${creditLimit} by operator=${operator.id}`,
      );
      return { settlementCode, before, after: creditLimit };
    });
  }

  /** settlement_code(owner_id) 로 wallet_account 를 FOR UPDATE(락 모드 지정) 조회. 없으면 null. */
  private lockWalletByCode(
    manager: EntityManager,
    code: string,
    lockMode: 'pessimistic_write' | 'pessimistic_write_or_fail',
  ): Promise<WalletAccountEntity | null> {
    return manager
      .getRepository(WalletAccountEntity)
      .createQueryBuilder('w')
      .setLock(lockMode)
      .where('w.ownerType = :t', { t: 'SETTLEMENT_CODE' })
      .andWhere('w.ownerId = :c', { c: code })
      .getOne();
  }

  /**
   * 변경 게이트 (assign / issue 공용) — plan Change gate predicate.
   * (a) 진행 중 주문 없음 + 미정산 완료 없음 + all_settle=0.
   * (b) SOURCE 코드의 마지막 사용자면 SOURCE 풀이 비어 있어야 함 (deposit/credit_used/credit_excess/points=0).
   * H2: SOURCE wallet 은 FOR UPDATE NOWAIT 로 잠근 뒤 잔액을 읽는다 (TOCTOU 차단).
   */
  private async assertChangeGate(
    manager: EntityManager,
    companyUsers: UserEntity[],
    movingUserId: number,
    sourceCode: string,
  ): Promise<void> {
    await this.assertNoOutstanding(manager, movingUserId);

    if (!sourceCode || sourceCode === '') {
      return; // PENDING(미배정) → 비울 풀 없음 (H2 잠금 대상 없음).
    }

    // H2: SOURCE wallet FOR UPDATE NOWAIT — 잔액 읽기 전에 잠근다 (동시 settle/refund/resend 직렬화 or rollback/retry).
    const sourceWallet = await this.lockWalletByCode(manager, sourceCode, 'pessimistic_write_or_fail');

    // 마지막 사용자 판정 — 잠긴 회사 사용자 목록 기준.
    const codeUsers = companyUsers.filter((u) => u.settlementCode === sourceCode);
    const isLastUser = codeUsers.length === 1 && codeUsers[0].id === movingUserId;
    if (!isLastUser || !sourceWallet) {
      return; // 남은 co-user 가 풀을 계속 사용 → orphan 아님. 풀 없으면 비울 것도 없음.
    }

    const hasPoints = await this.hasRemainingPoints(manager, sourceWallet.id);
    const isEmpty =
      sourceWallet.depositBalance === 0 &&
      sourceWallet.creditUsedAmount === 0 &&
      sourceWallet.creditExcessAmount === 0 &&
      !hasPoints;
    if (!isEmpty) {
      throw new BadRequestException(
        `마지막 사용자를 이동하면 정산코드('${sourceCode}') 풀이 고아가 됩니다. ` +
          `잔액/여신/포인트를 먼저 정리(환불/정산)한 뒤 이동하세요. ` +
          `(deposit=${sourceWallet.depositBalance}, credit_used=${sourceWallet.creditUsedAmount}, ` +
          `credit_excess=${sourceWallet.creditExcessAmount}, points=${hasPoints ? '>0' : '0'})`,
      );
    }
  }

  /** 변경 게이트 (a): all_settle=0 이고 진행 중/미정산 주문이 없어야 한다 (billing identity = clientUserId ?? userId). */
  private async assertNoOutstanding(manager: EntityManager, movingUserId: number): Promise<void> {
    const movingUser = await manager
      .getRepository(UserEntity)
      .findOne({ where: { id: movingUserId }, select: ['id', 'allSettleAmount'] });
    if (movingUser && movingUser.allSettleAmount !== 0) {
      throw new BadRequestException(
        `미정산 외상 잔액이 남아 있어 정산코드를 변경할 수 없습니다. (all_settle=${movingUser.allSettleAmount})`,
      );
    }

    const outstanding = await manager
      .getRepository(OrderEntity)
      .createQueryBuilder('o')
      .where('COALESCE(o.clientUserId, o.userId) = :uid', { uid: movingUserId })
      .andWhere(
        new Brackets((qb) => {
          qb.where('o.status IN (:...inflight)', { inflight: CHANGE_GATE_INFLIGHT_STATUSES }).orWhere(
            '(o.status = :dc AND (o.settleStatus IS NULL OR o.settleStatus != :sc))',
            { dc: IOrderStatus.DELIVERY_COMPLETE, sc: SETTLE_COMPLETE },
          );
        }),
      )
      .getCount();
    if (outstanding > 0) {
      throw new BadRequestException(
        '진행 중이거나 미정산 완료된 주문이 있어 정산코드를 변경할 수 없습니다. (발송요청/검토완료/발송확정 또는 미정산 발송완료 주문)',
      );
    }
  }

  /** SOURCE 풀에 사용 가능한 잔여 포인트가 있는지. */
  private async hasRemainingPoints(manager: EntityManager, walletAccountId: string): Promise<boolean> {
    const row = await manager
      .getRepository(PointGrantEntity)
      .createQueryBuilder('p')
      .select('COALESCE(SUM(p.remainingAmount), 0)', 'total')
      .where('p.walletAccountId = :wid', { wid: walletAccountId })
      .andWhere('p.active = 1')
      .andWhere('p.remainingAmount > 0')
      .andWhere('(p.expiresAt IS NULL OR p.expiresAt > :now)', { now: new Date() })
      .getRawOne<{ total: string }>();
    return Number(row?.total ?? 0) > 0;
  }

  /** company-{id}-{n} 다음 n 계산 (기존 wallet owner_id 숫자 suffix 최댓값 +1). 회사 row 잠금 하에서 호출. */
  private async nextIssuedCode(manager: EntityManager, companyId: number): Promise<string> {
    const prefix = `company-${companyId}-`;
    const rows = await manager
      .getRepository(WalletAccountEntity)
      .createQueryBuilder('w')
      .select('w.ownerId', 'ownerId')
      .where('w.ownerType = :t', { t: 'SETTLEMENT_CODE' })
      .andWhere('w.ownerId LIKE :p', { p: `${prefix}%` })
      .getRawMany<{ ownerId: string }>();

    let max = 0;
    for (const r of rows) {
      const suffix = String(r.ownerId).slice(prefix.length);
      if (/^\d+$/.test(suffix)) {
        max = Math.max(max, parseInt(suffix, 10));
      }
    }
    return `${prefix}${max + 1}`;
  }

  /** lock-conflict(NOWAIT) / uq_wallet_owner 충돌 시 1회 재시도. */
  private async runWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (this.isRetryableConflict(e)) {
        this.logger.warn(`settlement-code mutation conflict — retry once (${(e as Error)?.message ?? e})`);
        return fn();
      }
      throw e;
    }
  }

  private isRetryableConflict(e: unknown): boolean {
    const err = e as {
      code?: string;
      errno?: number;
      message?: string;
      driverError?: { code?: string; errno?: number };
    };
    const code = err?.code ?? err?.driverError?.code ?? '';
    const errno = err?.errno ?? err?.driverError?.errno;
    const message = err?.message ?? '';
    // 3572 ER_LOCK_NOWAIT, 1205 lock wait timeout, 1062 ER_DUP_ENTRY(uq_wallet_owner).
    if (errno === 3572 || errno === 1205 || errno === 1062) return true;
    return /NOWAIT|ER_LOCK_NOWAIT|ER_DUP_ENTRY|Duplicate entry|lock wait timeout/i.test(`${code} ${message}`);
  }
}
