import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
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
import { WalletLedgerService } from './wallet-ledger.service';
import { WalletResourceType } from '../interface/wallet-resource-type';
import { ActivityLogEntity } from '../../entity/activity.log.entity';
import { WalletTransactionEntity } from '../../entity/wallet.transaction.entity';
import { createHash } from 'crypto';

export type SettlementJoinMode = 'NEW' | 'SHARE_ONE' | 'PENDING';

export interface SettlementJoinClassification {
  mode: SettlementJoinMode;
  code?: string;
}

export type SettlementCodeHistoryEventType = 'CREDIT_LIMIT_CHANGED' | 'SETTLE_POLICY_CHANGED' | 'DEPOSIT_CHARGED';

/** 정산코드 변경 이력 공통 항목(정책/한도=activity_log, 예치금=wallet_transaction). */
export interface SettlementCodeHistoryItem {
  source: 'ACTIVITY_LOG' | 'WALLET_TRANSACTION';
  sourceId: string;
  eventType: SettlementCodeHistoryEventType;
  occurredAt: Date;
  operatorId: number | null;
  operatorEmail: string | null;
  before?: unknown;
  after?: unknown;
  memo?: string | null;
}

export interface HistoryPage {
  items: SettlementCodeHistoryItem[];
  nextCursor: string | null;
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
    private readonly walletLedger: WalletLedgerService,
    @InjectRepository(ActivityLogEntity)
    private readonly activityLogRepository: Repository<ActivityLogEntity>,
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
        const { user } = await this.billingScopeLock.lock(userId, manager);

        const sourceCode = user.settlementCode ?? '';
        if (sourceCode === targetCode) {
          return; // 이미 해당 코드 — no-op (target 검증 불필요).
        }

        // targetCode 는 시스템 전역에 실재하는 정산코드여야 한다 (교차 회사 공유 허용, 결정 #6 — 삼성 주문/제일모직 계산 케이스).
        // wallet_account 가 없으면 배정 시 참조 무결성이 깨지므로 fail-closed. 자금은 이동하지 않는다(pooled).
        const targetWallet = await this.lockWalletByCode(manager, targetCode, 'pessimistic_write');
        if (!targetWallet) {
          throw new BadRequestException(
            `대상 정산코드('${targetCode}')의 wallet_account 를 찾을 수 없습니다. (issue 로 신규 발급하거나 실재하는 코드를 지정하세요.)`,
          );
        }

        await this.assertChangeGate(manager, userId, sourceCode);
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
        const { user } = await this.billingScopeLock.lock(userId, manager);
        const companyId = user.companyId;
        if (companyId == null) {
          throw new BadRequestException('회사가 연결되지 않은 계정은 정산코드를 발급할 수 없습니다.');
        }

        const sourceCode = user.settlementCode ?? '';
        await this.assertChangeGate(manager, userId, sourceCode);

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

      // **oldCode wallet FOR UPDATE (P1 rename↔assign 직렬화)**: assignUserToCode 는 target 코드 wallet 을 FOR UPDATE 로
      // 잠근다. rename 도 oldCode wallet 을 먼저 잠가 두 경로를 직렬화한다 — 그렇지 않으면 foreignRef 검증 직후 타 회사
      // 사용자가 oldCode 로 배정되어, wallet owner 만 newCode 로 바뀌고 그 사용자가 wallet 없는 dangling code 를 참조한다.
      const oldWallet = await this.lockWalletByCode(manager, oldCode, 'pessimistic_write');
      if (!oldWallet) {
        throw new BadRequestException(`정산코드('${oldCode}') 의 wallet_account 를 찾을 수 없습니다.`);
      }

      // **공유 코드 리네임 불가 계약 (결정 #6 파생)**: 교차 회사 공유가 정상 경로가 되었으므로 "foreign drift"가 아니라
      // 명시적 계약으로 정리한다 — rename 의 최종 UPDATE 는 이 회사(companyId) users 만 갱신하므로, 타 회사/회사미연결
      // 참조자가 있으면 그들은 옛 코드를 계속 가리켜 wallet 없는 code 참조가 된다. 따라서 **단일 회사 전용 코드만 rename 허용**.
      const foreignRefCount = await manager
        .getRepository(UserEntity)
        .createQueryBuilder('u')
        .where('u.settlementCode = :oldCode', { oldCode })
        .andWhere('(u.companyId != :companyId OR u.companyId IS NULL)', { companyId })
        .getCount();
      if (foreignRefCount > 0) {
        throw new BadRequestException(
          `정산코드('${oldCode}')는 다른 회사(또는 회사미연결) 사용자와 공유 중이라 리네임할 수 없습니다. 리네임은 단일 회사 전용 코드에서만 허용됩니다.`,
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
  ): Promise<{ settlementCode: string; before: number; after: number; belowCurrentUsage: boolean }> {
    if (!Number.isInteger(creditLimit) || creditLimit < 0) {
      throw new BadRequestException('여신 한도(creditLimit)는 0 이상의 정수여야 합니다.');
    }
    return this.dataSource.transaction(async (manager) => {
      const wallet = await this.lockWalletByCode(manager, settlementCode, 'pessimistic_write');
      if (!wallet) {
        throw new BadRequestException(`정산코드('${settlementCode}') 의 wallet_account 를 찾을 수 없습니다.`);
      }

      const before = wallet.creditLimit;
      // creditLimit < 현재 사용액 설정 허용(기존 사용액/초과액은 불변). 신규 차감 가용 여신은 max(0, limit-used)=0.
      const belowCurrentUsage = creditLimit < wallet.creditUsedAmount;
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
      }, manager); // 동일 트랜잭션 감사(정책/한도 변경 정본).

      this.logger.log(
        `setCodeCreditLimit code=${settlementCode} ${before} -> ${creditLimit} by operator=${operator.id}`,
      );
      return { settlementCode, before, after: creditLimit, belowCurrentUsage };
    });
  }

  /**
   * 운영자: 정산코드 단위 정산조건(선/후정산)·정산방법(카드/현금)을 변경한다.
   *
   * wallet FOR UPDATE + activity_log(SETTLE_CODE_POLICY_MODIFY). 부분 변경 허용(둘 중 하나만).
   * **정산조건 변경**은 코드를 공유하는 전체 계정에 진행 중/미정산 주문이 없어야 한다(결정 #5) — 미정산 주문의 정산 규칙 전환 위험 차단.
   * 정산방법 변경은 주문 시점에 `order.cardSurchargeApplied`로 박제되므로 게이트 없음.
   */
  async setSettlePolicy(
    settlementCode: string,
    update: { settleCondition?: 'PRE_PAYMENT' | 'POST_PAYMENT'; settleMethod?: 'CARD' | 'CASH' },
    operator: ILoginUserInfo,
  ): Promise<{
    settlementCode: string;
    before: { settleCondition: 'PRE_PAYMENT' | 'POST_PAYMENT'; settleMethod: 'CARD' | 'CASH' };
    after: { settleCondition: 'PRE_PAYMENT' | 'POST_PAYMENT'; settleMethod: 'CARD' | 'CASH' };
    noop?: boolean;
  }> {
    if (update.settleCondition === undefined && update.settleMethod === undefined) {
      throw new BadRequestException('변경할 항목(settleCondition/settleMethod)이 없습니다.');
    }
    return this.runWithRetry(() =>
      this.dataSource.transaction(async (manager) => {
        // **정산조건 전환 직렬화 (P1)**: 주문 상태 전이(deliveryRequest)는 wallet 을 잠그지 않고 BillingScopeLock
        // (회사 계정=회사 row+users, 회사미연결 계정=개인 user row FOR UPDATE)만 잡는다. wallet 만 잠그면 게이트 통과
        // 직후 진행 주문이 유입될 수 있다. 그래서:
        //  1) **코드 wallet 을 먼저 FOR UPDATE** — assignUserToCode(가입=target wallet, 이탈=source wallet FOR UPDATE)와
        //     동일 경계를 공유해 정책 변경 중 코드 멤버십을 동결한다(신규 가입/이탈 차단).
        //  2) 동결된 멤버십으로 **모든 회사 + 회사미연결 사용자**를 잠근다(deliveryRequest 와 동일 락 집합).
        //  3) 락 후 진행 주문 재검증. deliveryConfirmed(회사→wallet)와 락 순서가 반대라 데드락 시 runWithRetry.
        const wallet = await this.lockWalletByCode(manager, settlementCode, 'pessimistic_write');
        if (!wallet) {
          throw new BadRequestException(`정산코드('${settlementCode}') 의 wallet_account 를 찾을 수 없습니다.`);
        }

        const before = { settleCondition: wallet.settleCondition, settleMethod: wallet.settleMethod };

        const condChanged = update.settleCondition !== undefined && update.settleCondition !== wallet.settleCondition;
        const methodChanged = update.settleMethod !== undefined && update.settleMethod !== wallet.settleMethod;

        // **동일값(no-op)**: 요청값이 현재값과 같으면 저장/감사 로그 없이 현재값 반환(감사 노이즈 방지).
        if (!condChanged && !methodChanged) {
          return { settlementCode, before, after: before, noop: true };
        }

        if (condChanged) {
          // 멤버십 동결(wallet 락) 상태에서 모든 회사 + 회사미연결 사용자 락 확보 → 진행 주문 재검증.
          const companyIds = await this.distinctCompanyIdsForCode(manager, settlementCode);
          for (const companyId of companyIds) {
            await this.billingScopeLock.lockByCompany(companyId, manager);
          }
          await this.lockCompanylessCodeUsers(manager, settlementCode);
          // **구조화된 게이트 오류**(문자열 파싱 금지): 어떤 계정/주문이 차단하는지 배열로 반환.
          const outstanding = await this.collectOutstandingForCode(manager, settlementCode);
          if (outstanding.blockingUserIds.length > 0 || outstanding.blockingOrderCount > 0) {
            throw new BadRequestException({
              code: 'OUTSTANDING_ORDER_EXISTS',
              message: '진행 중이거나 미정산 완료된 주문이 있어 정산조건을 변경할 수 없습니다.',
              blockingUserIds: outstanding.blockingUserIds,
              blockingOrderCount: outstanding.blockingOrderCount, // 전체 차단 주문 수
              blockingOrderIds: outstanding.blockingOrderIds, // 대표 최대 20건
            });
          }
          wallet.settleCondition = update.settleCondition!;
        }
        if (methodChanged) {
          wallet.settleMethod = update.settleMethod!;
        }
        await manager.getRepository(WalletAccountEntity).save(wallet);

        const after = { settleCondition: wallet.settleCondition, settleMethod: wallet.settleMethod };
        await this.activityLogService.createLog({
          userId: operator.id,
          userEmail: operator.email,
          method: 'PUT',
          requestUrl: '/settlement-codes/settle-policy',
          actionType: ActivityLogActionType.SETTLE_CODE_POLICY_MODIFY,
          ipAddress: '',
          statusCode: 200,
          result: ActivityLogResult.SUCCESS,
          responseTime: 0,
          requestParams: { settlementCode, before, after },
        }, manager); // 동일 트랜잭션 감사(정책 변경 정본).

        this.logger.log(
          `setSettlePolicy code=${settlementCode} ${JSON.stringify(before)} -> ${JSON.stringify(after)} by operator=${operator.id}`,
        );
        return { settlementCode, before, after };
      }),
    );
  }

  /**
   * 운영자: 정산코드 단위 예치금 충전 (코드 공유 wallet.deposit_balance 증가).
   *
   * **멱등**: `requestKey` 필수(응답 유실 재시도 안정 키). idempotencyKey = `ADMIN_DEPOSIT:{sha256(walletId:requestKey)}`
   * (조합 후 길이 초과 방지 위해 해시). 같은 requestKey·다른 금액 = **409**(payload 불일치). 같은 requestKey·같은 금액
   * 재시도 = 최초 원장의 금액/잔액을 반환하고 **신규 이력 미기록**. 신규 충전만 WalletLedgerService.recordTransaction(DEPOSIT)
   * + activity_log(BALANCE_CHARGE).
   */
  async chargeDeposit(
    settlementCode: string,
    chargeAmount: number,
    operator: ILoginUserInfo,
    memo: string | undefined,
    requestKey: string,
  ): Promise<{ settlementCode: string; charged: number; depositBalanceAfter: number; isDuplicate: boolean }> {
    if (!Number.isInteger(chargeAmount) || chargeAmount <= 0) {
      throw new BadRequestException('충전 금액(chargeAmount)은 1 이상의 정수여야 합니다.');
    }
    if (!requestKey || requestKey.trim() === '') {
      throw new BadRequestException('requestKey 는 필수입니다 (멱등 재시도 안정 키).');
    }
    const wallet = await this.dataSource
      .getRepository(WalletAccountEntity)
      .findOne({ where: { ownerType: 'SETTLEMENT_CODE', ownerId: settlementCode } });
    if (!wallet) {
      throw new BadRequestException(`정산코드('${settlementCode}') 의 wallet_account 를 찾을 수 없습니다.`);
    }

    // 조합 키 길이(VARCHAR 120) 초과 방지: (walletId:requestKey) 를 sha256 해시.
    const digest = createHash('sha256').update(`${wallet.id}:${requestKey.trim()}`).digest('hex');
    const idempotencyKey = `ADMIN_DEPOSIT:${digest}`;

    // 기존 원장 있으면 payload(금액) 검증. 다르면 409, 같으면 최초 사실 반환(이력 미기록).
    const txRepo = this.dataSource.getRepository(WalletTransactionEntity);
    const existing = await txRepo.findOne({ where: { idempotencyKey } });
    if (existing) {
      if (existing.amount !== chargeAmount) {
        throw new ConflictException(
          `동일 requestKey 로 다른 금액이 요청되었습니다 (최초 ${existing.amount} ≠ 요청 ${chargeAmount}).`,
        );
      }
      return {
        settlementCode,
        charged: existing.amount,
        depositBalanceAfter: existing.balanceAfter ?? 0,
        isDuplicate: true,
      };
    }

    const result = await this.walletLedger.recordTransaction({
      walletAccountId: wallet.id,
      type: 'CHARGE',
      resourceType: WalletResourceType.DEPOSIT,
      amount: chargeAmount,
      memo: memo ?? null,
      idempotencyKey,
      operatorId: operator.id,
      operatorEmail: operator.email,
    });

    // 동시성 race: 다른 요청이 먼저 기록한 경우 최초 사실 반환(이력 미기록). 금액 불일치면 409.
    if (result.isDuplicate) {
      const fresh = await txRepo.findOne({ where: { idempotencyKey } });
      if (fresh && fresh.amount !== chargeAmount) {
        throw new ConflictException(
          `동일 requestKey 로 다른 금액이 요청되었습니다 (최초 ${fresh.amount} ≠ 요청 ${chargeAmount}).`,
        );
      }
      return {
        settlementCode,
        charged: fresh?.amount ?? chargeAmount,
        depositBalanceAfter: result.balanceAfter,
        isDuplicate: true,
      };
    }

    // **감사 정본 = wallet_transaction**(운영자/전후잔액/멱등키 보존). activity_log 는 보조이며 **best-effort** —
    // 실패해도 이미 커밋된 충전을 API 실패로 노출하지 않는다(원장이 정본이므로 감사 누락 없음).
    try {
      await this.activityLogService.createLog({
        userId: operator.id,
        userEmail: operator.email,
        method: 'POST',
        requestUrl: '/settlement-codes/deposits',
        actionType: ActivityLogActionType.BALANCE_CHARGE,
        ipAddress: '',
        statusCode: 200,
        result: ActivityLogResult.SUCCESS,
        responseTime: 0,
        requestParams: { settlementCode, chargeAmount, memo: memo ?? null, requestKey: requestKey.trim() },
      });
    } catch (e) {
      this.logger.warn(
        `chargeDeposit activity_log best-effort 실패(원장은 커밋됨, 감사 정본은 wallet_transaction): code=${settlementCode} ${(e as Error)?.message ?? e}`,
      );
    }

    this.logger.log(
      `chargeDeposit code=${settlementCode} +${chargeAmount} balanceAfter=${result.balanceAfter} by operator=${operator.id}`,
    );
    return {
      settlementCode,
      charged: chargeAmount,
      depositBalanceAfter: result.balanceAfter,
      isDuplicate: false,
    };
  }

  /**
   * 운영자: 정산코드 **정책/여신한도** 변경 이력 (activity_log 기반, cursor pagination).
   * 예치금 충전 이력은 감사 정본이 wallet_transaction 이므로 getDepositHistory(GET /deposits)에서 조회한다.
   * eventType 미지정 시 정책+한도 전체. 정렬 createdAt DESC, id DESC. limit 기본 50, 최대 100.
   */
  async getCodeHistory(
    settlementCode: string,
    opts: { limit?: number; cursor?: string; eventType?: SettlementCodeHistoryEventType } = {},
  ): Promise<HistoryPage> {
    if (!settlementCode || settlementCode.trim() === '') {
      throw new BadRequestException('settlementCode 는 필수입니다.');
    }
    const limit = this.normalizeLimit(opts.limit);
    const cursor = this.decodeCursor(opts.cursor); // 잘못된 cursor 는 DB 접근 전에 400.

    const actionByEvent: Partial<Record<SettlementCodeHistoryEventType, ActivityLogActionType>> = {
      CREDIT_LIMIT_CHANGED: ActivityLogActionType.MAXIMUM_LIMIT_MODIFY,
      SETTLE_POLICY_CHANGED: ActivityLogActionType.SETTLE_CODE_POLICY_MODIFY,
    };
    let types = [ActivityLogActionType.MAXIMUM_LIMIT_MODIFY, ActivityLogActionType.SETTLE_CODE_POLICY_MODIFY];
    if (opts.eventType !== undefined) {
      const mapped = actionByEvent[opts.eventType];
      if (!mapped) {
        throw new BadRequestException(
          'eventType 은 CREDIT_LIMIT_CHANGED | SETTLE_POLICY_CHANGED 만 허용됩니다(예치금 이력은 GET /settlement-codes/deposits).',
        );
      }
      types = [mapped];
    }

    const qb = this.activityLogRepository
      .createQueryBuilder('a')
      .where('a.deletedAt IS NULL')
      .andWhere('a.actionType IN (:...types)', { types })
      .andWhere("JSON_UNQUOTE(JSON_EXTRACT(a.requestParams, '$.settlementCode')) = :code", { code: settlementCode });

    if (cursor) {
      qb.andWhere('a.id < :cId', { cId: Number(cursor.id) });
    }

    // 단일 테이블 + auto-increment PK 라 id DESC 만으로 생성순·유일 정렬(DATETIME(6) 정밀도 무관).
    const rows = await qb.orderBy('a.id', 'DESC').limit(limit + 1).getMany();
    const { page, nextCursor } = this.pageWithCursor(rows, limit);
    const items = page.map((r) => this.mapActivityLogItem(r));
    return { items, nextCursor };
  }

  /**
   * 운영자: 정산코드 **예치금 충전** 이력 (wallet_transaction 감사 정본, cursor pagination).
   * 정렬 id DESC(auto-increment PK = 생성순, 유일). limit 기본 50, 최대 100.
   */
  async getDepositHistory(settlementCode: string, opts: { limit?: number; cursor?: string } = {}): Promise<HistoryPage> {
    if (!settlementCode || settlementCode.trim() === '') {
      throw new BadRequestException('settlementCode 는 필수입니다.');
    }
    const wallet = await this.dataSource
      .getRepository(WalletAccountEntity)
      .findOne({ where: { ownerType: 'SETTLEMENT_CODE', ownerId: settlementCode } });
    if (!wallet) {
      throw new BadRequestException(`정산코드('${settlementCode}') 의 wallet_account 를 찾을 수 없습니다.`);
    }
    const limit = this.normalizeLimit(opts.limit);
    const cursor = this.decodeCursor(opts.cursor);

    const qb = this.dataSource
      .getRepository(WalletTransactionEntity)
      .createQueryBuilder('t')
      .where('t.walletAccountId = :wid', { wid: wallet.id })
      .andWhere('t.resourceType = :rt', { rt: WalletResourceType.DEPOSIT })
      .andWhere('t.type = :ty', { ty: 'CHARGE' });

    if (cursor) {
      qb.andWhere('t.id < :cId', { cId: cursor.id });
    }

    // 단일 테이블 + auto-increment PK 라 id DESC 만으로 생성순·유일 정렬(DATETIME(6) 정밀도 무관).
    const rows = await qb.orderBy('t.id', 'DESC').limit(limit + 1).getMany();
    const { page, nextCursor } = this.pageWithCursor(rows, limit);
    const items: SettlementCodeHistoryItem[] = page.map((t) => ({
      source: 'WALLET_TRANSACTION',
      sourceId: String(t.id),
      eventType: 'DEPOSIT_CHARGED',
      occurredAt: t.createdAt,
      operatorId: t.operatorId ?? null,
      operatorEmail: t.operatorEmail ?? null,
      before: t.balanceBefore,
      after: t.balanceAfter,
      memo: t.memo,
    }));
    return { items, nextCursor };
  }

  private mapActivityLogItem(r: ActivityLogEntity): SettlementCodeHistoryItem {
    const params = (r.requestParams ?? {}) as Record<string, unknown>;
    if (r.actionType === ActivityLogActionType.MAXIMUM_LIMIT_MODIFY) {
      return {
        source: 'ACTIVITY_LOG',
        sourceId: String(r.id),
        eventType: 'CREDIT_LIMIT_CHANGED',
        occurredAt: r.createdAt,
        operatorId: r.userId,
        operatorEmail: r.userEmail,
        before: params.beforeMaximumLimit,
        after: params.afterMaximumLimit,
      };
    }
    return {
      source: 'ACTIVITY_LOG',
      sourceId: String(r.id),
      eventType: 'SETTLE_POLICY_CHANGED',
      occurredAt: r.createdAt,
      operatorId: r.userId,
      operatorEmail: r.userEmail,
      before: params.before,
      after: params.after,
    };
  }

  private normalizeLimit(limit?: number): number {
    if (limit === undefined || !Number.isFinite(limit)) return 50;
    return Math.min(100, Math.max(1, Math.floor(limit)));
  }

  private encodeCursor(id: string | number): string {
    return Buffer.from(JSON.stringify({ id: String(id) })).toString('base64url');
  }

  /** cursor 기반 페이지 계산: limit+1 조회 결과에서 실제 페이지 + nextCursor 를 산출(getCodeHistory/getDepositHistory 공용). */
  private pageWithCursor<T extends { id: string | number }>(
    rows: T[],
    limit: number,
  ): { page: T[]; nextCursor: string | null } {
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor = rows.length > limit && last ? this.encodeCursor(last.id) : null;
    return { page, nextCursor };
  }

  private decodeCursor(cursor?: string): { id: string } | null {
    if (cursor === undefined || cursor === '') return null;
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { id?: unknown };
      // id: 양의 정수 문자열만 허용(그 외 전부 400). 단일 테이블 정렬이라 timestamp 는 cursor 에 불필요.
      const idStr = String(parsed?.id);
      if (!/^\d+$/.test(idStr) || idStr === '0') {
        throw new Error('cursor id');
      }
      return { id: idStr };
    } catch {
      throw new BadRequestException('cursor 형식이 올바르지 않습니다.');
    }
  }

  /**
   * 정산코드를 공유하는 전체 계정에서 진행 중/미정산 주문(또는 미정산 외상 잔액)을 **수집**한다(선/후정산 전환 게이트).
   * 대량 응답/락 보유시간 방지: 전체 count 는 집계로, 대표 주문 ID 는 최대 REP_LIMIT 건만 조회한다.
   * blockingUserIds 는 코드 멤버 수로 유계이므로 DISTINCT 전량 수집.
   */
  private async collectOutstandingForCode(
    manager: EntityManager,
    settlementCode: string,
  ): Promise<{ blockingUserIds: number[]; blockingOrderIds: number[]; blockingOrderCount: number }> {
    const REP_LIMIT = 20;
    const users = await manager
      .getRepository(UserEntity)
      .find({ where: { settlementCode }, select: ['id', 'allSettleAmount'] });
    const blockingUserIds = new Set<number>();
    for (const u of users) {
      if (typeof u.allSettleAmount === 'number' && u.allSettleAmount !== 0) {
        blockingUserIds.add(u.id);
      }
    }

    const blockingOrderIds: number[] = [];
    let blockingOrderCount = 0;
    const userIds = users.map((u) => u.id);
    if (userIds.length > 0) {
      // (1) 전체 차단 주문 수(집계만 — row 미적재).
      blockingOrderCount = await this.outstandingOrdersQuery(manager, userIds).getCount();

      if (blockingOrderCount > 0) {
        // (2) 대표 주문 ID 최대 REP_LIMIT 건.
        const repRows = await this.outstandingOrdersQuery(manager, userIds)
          .select('o.id', 'id')
          .orderBy('o.id', 'DESC')
          .limit(REP_LIMIT)
          .getRawMany<{ id: number }>();
        for (const r of repRows) {
          blockingOrderIds.push(Number(r.id));
        }

        // (3) 차단 주문의 DISTINCT billing user(대표 주문에 없어도 누락되지 않도록 별도 집계).
        const uidRows = await this.outstandingOrdersQuery(manager, userIds)
          .select('DISTINCT COALESCE(o.clientUserId, o.userId)', 'uid')
          .getRawMany<{ uid: number }>();
        for (const r of uidRows) {
          blockingUserIds.add(Number(r.uid));
        }
      }
    }

    return { blockingUserIds: [...blockingUserIds], blockingOrderIds, blockingOrderCount };
  }

  /** collectOutstandingForCode 의 3개 조회가 공유하는 base queryBuilder (대상 사용자 + 진행 중/미정산 필터). */
  private outstandingOrdersQuery(manager: EntityManager, userIds: number[]) {
    return manager
      .getRepository(OrderEntity)
      .createQueryBuilder('o')
      .where('COALESCE(o.clientUserId, o.userId) IN (:...uids)', { uids: userIds })
      .andWhere(
        new Brackets((qb) => {
          qb.where('o.status IN (:...inflight)', { inflight: CHANGE_GATE_INFLIGHT_STATUSES }).orWhere(
            '(o.status = :dc AND (o.settleStatus IS NULL OR o.settleStatus != :sc))',
            { dc: IOrderStatus.DELIVERY_COMPLETE, sc: SETTLE_COMPLETE },
          );
        }),
      );
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

  /** 정산코드를 참조하는 사용자들의 DISTINCT companyId (오름차순, NULL 제외) — 정책 게이트 회사 락 대상. */
  private async distinctCompanyIdsForCode(manager: EntityManager, settlementCode: string): Promise<number[]> {
    const rows = await manager
      .getRepository(UserEntity)
      .createQueryBuilder('u')
      .select('DISTINCT u.companyId', 'companyId')
      .where('u.settlementCode = :code', { code: settlementCode })
      .andWhere('u.companyId IS NOT NULL')
      .orderBy('u.companyId', 'ASC')
      .getRawMany<{ companyId: number }>();
    return rows.map((r) => Number(r.companyId));
  }

  /**
   * 정산코드를 참조하는 **회사미연결(companyId NULL)** 사용자 row 를 FOR UPDATE 로 잠근다.
   * 이들은 deliveryRequest 시 개인 user row 만 잠기므로(회사 락 밖), 정책 게이트도 동일하게 개인 row 를 잠가야 직렬화된다.
   */
  private async lockCompanylessCodeUsers(manager: EntityManager, settlementCode: string): Promise<void> {
    await manager
      .getRepository(UserEntity)
      .createQueryBuilder('u')
      .setLock('pessimistic_write')
      .where('u.settlementCode = :code', { code: settlementCode })
      .andWhere('u.companyId IS NULL')
      .orderBy('u.id', 'ASC')
      .getMany();
  }

  /**
   * 변경 게이트 (assign / issue 공용) — plan Change gate predicate.
   * (a) 진행 중 주문 없음 + 미정산 완료 없음 + all_settle=0.
   * (b) SOURCE 코드의 마지막 사용자면 SOURCE 풀이 비어 있어야 함 (deposit/credit_used/credit_excess/points=0).
   * H2: SOURCE wallet 은 FOR UPDATE NOWAIT 로 잠근 뒤 잔액을 읽는다 (TOCTOU 차단).
   */
  private async assertChangeGate(
    manager: EntityManager,
    movingUserId: number,
    sourceCode: string,
  ): Promise<void> {
    await this.assertNoOutstanding(manager, movingUserId);

    if (!sourceCode || sourceCode === '') {
      return; // PENDING(미배정) → 비울 풀 없음 (H2 잠금 대상 없음).
    }

    // H2: SOURCE wallet FOR UPDATE NOWAIT — 잔액 읽기 전에 잠근다 (동시 settle/refund/resend 직렬화 or rollback/retry).
    const sourceWallet = await this.lockWalletByCode(manager, sourceCode, 'pessimistic_write_or_fail');

    // 마지막 사용자 판정 — **코드 전역 참조자 기준**(교차 회사 공유 대응, 결정 #6).
    // companyUsers(현재 회사)만 보면 타 회사에 공유 사용자가 남아도 orphan 으로 오판해 이동을 부당 차단한다.
    const globalCodeUserCount = await manager
      .getRepository(UserEntity)
      .count({ where: { settlementCode: sourceCode } });
    const isLastUser = globalCodeUserCount === 1; // 유일 참조자 = 이동 대상 본인.
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
    // 3572 ER_LOCK_NOWAIT, 1205 lock wait timeout, 1213 ER_LOCK_DEADLOCK, 1062 ER_DUP_ENTRY(uq_wallet_owner).
    if (errno === 3572 || errno === 1205 || errno === 1213 || errno === 1062) return true;
    return /NOWAIT|ER_LOCK_NOWAIT|ER_DUP_ENTRY|Duplicate entry|lock wait timeout|Deadlock/i.test(`${code} ${message}`);
  }
}
