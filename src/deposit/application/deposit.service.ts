import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BankDepositEntity } from '../../entity/bank.deposit.entity';
import { WalletAccountEntity, WalletAccountOwnerType } from '../../entity/wallet.account.entity';
import { UserCompanyEntity } from '../../entity/user.company.entity';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { ActivityLogService } from '../../activity_log/application/activity.log.service';
import { ActivityLogActionType } from '../../activity_log/interface/activity.log.action.type';
import { ActivityLogResult } from '../../activity_log/interface/activity.log.result';
import { MaskingUtil } from '../../common/utils/masking.util';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { DepositGetListReqQueryDto } from '../api/deposit.req.dto';
import {
  DepositAccountViewDto,
  DepositGetAccountListResDto,
  DepositGetListResDto,
  DepositViewDto,
} from '../api/deposit.res.dto';
import { DEPOSIT_TX_TYPE_TO_DB, toDepositTxType } from '../interface/deposit.tx.type';

/**
 * 현재 유일하게 표시명을 해석할 수 있는 지갑 주인 타입.
 * wallet_account.ownerType 과 같은 어휘를 쓴다(같은 개념에 같은 이름).
 */
const SETTLEMENT_CODE_OWNER_TYPE: WalletAccountOwnerType = 'SETTLEMENT_CODE';

/**
 * 표시명 맵의 키. 타입이 늘어나면 서로 다른 타입에 같은 id 가 존재할 수 있으므로
 * id 단독이 아니라 (타입, id) 쌍을 키로 쓴다.
 */
const ownerKey = (ownerType: string, ownerId: string): string => `${ownerType}|${ownerId}`;

/** 입금처 검색을 감사 로그에 남기기 위한 요청 맥락 */
export type DepositListAuditContext = {
  user: ILoginUserInfo;
  ipAddress: string;
  userAgent?: string;
};

/**
 * 입금내역 조회 서비스.
 *
 * 읽는 대상은 프리미엄이 소유한 미러 테이블이다. 그 테이블을 채우는 쪽은
 * DepositSyncService(erp_macro 조회 API 를 주기적으로 호출)이며, 이 서비스는 SELECT 만 한다.
 *
 * PII 4종(depositor/depositorRaw/erpPartnerName/erpPartnerCode)은 DB 에 암호문으로 있으므로
 * 응답을 만들기 전에 반드시 복호화한다.
 */
@Injectable()
export class DepositService {
  private logger = new Logger('DEPOSIT');

  constructor(
    @InjectRepository(BankDepositEntity)
    private bankDepositRepository: Repository<BankDepositEntity>,
    @InjectRepository(WalletAccountEntity)
    private walletAccountRepository: Repository<WalletAccountEntity>,
    private cryptoCipher: CryptoCipher,
    private activityLogService: ActivityLogService,
  ) {}

  async getList(getQuery: DepositGetListReqQueryDto, audit?: DepositListAuditContext): Promise<DepositGetListResDto> {
    const { startAt, endAt, txType, matchStatus, depositor, accountNo, page, take } = getQuery;

    // 뒤집힌 기간은 조용히 0건을 돌려주면 "데이터가 없다"로 오해되므로 입력 오류로 끊는다.
    if (startAt && endAt && startAt > endAt) {
      throw new BadRequestException('조회 시작일이 종료일보다 늦을 수 없습니다.');
    }

    let queryBuilder = this.bankDepositRepository.createQueryBuilder('deposit');

    // tx_date 는 DATE(시분초 없음)라 문자열 비교로 경계일이 정확히 포함된다.
    if (startAt) {
      queryBuilder = queryBuilder.andWhere('deposit.txDate >= :startAt', { startAt });
    }
    if (endAt) {
      queryBuilder = queryBuilder.andWhere('deposit.txDate <= :endAt', { endAt });
    }

    if (txType) {
      queryBuilder = queryBuilder.andWhere('deposit.txType = :txType', { txType: DEPOSIT_TX_TYPE_TO_DB[txType] });
    }

    if (matchStatus) {
      queryBuilder = queryBuilder.andWhere('deposit.matchStatus = :matchStatus', { matchStatus });
    }

    if (depositor) {
      const ciphers = await this.resolveDepositorCiphers(depositor);
      // ⚠️ 감사 로그는 결과 건수와 무관하게, 조기 반환보다 **먼저** 남긴다.
      // 0건이어도 "그 이름을 조회했다"는 사실 자체가 감사 대상이다. 오히려 이름을 바꿔가며
      // 훑는 행위는 0건 검색으로 나타나므로, 0건을 빼면 가장 수상한 패턴이 로그에서 사라진다.
      // (부재의 확인도 정보다 — "이 사람은 우리 고객이 아니다"를 알아낸 것이다)
      if (audit) {
        await this.recordPiiSearchLog(depositor, audit);
      }
      // 일치하는 입금처가 없으면 빈 결과. `IN ()` 는 SQL 오류라 조기 반환한다.
      if (ciphers.length === 0) {
        return { list: [], totalCount: 0, totalPage: 0, currentPage: page };
      }
      queryBuilder = queryBuilder.andWhere('deposit.depositor IN (:...depositorCiphers)', {
        depositorCiphers: ciphers,
      });
    }

    if (accountNo) {
      queryBuilder = queryBuilder.andWhere('deposit.accountNo = :accountNo', { accountNo });
    }

    // tx_date 는 같은 날짜가 대량으로 중복되고 MySQL 은 동률의 순서를 보장하지 않는다.
    // 유일값 id 를 타이브레이커로 붙이지 않으면 페이지 경계에서 행이 중복/누락된다.
    queryBuilder = queryBuilder.orderBy('deposit.txDate', 'DESC').addOrderBy('deposit.id', 'DESC');

    const skip = (page - 1) * take;
    queryBuilder = queryBuilder.take(take).skip(skip);

    const [depositList, totalCount] = await queryBuilder.getManyAndCount();
    const ownerNameMap = await this.loadMatchedOwnerNames(depositList);

    const list: DepositViewDto[] = depositList.map((deposit) => ({
      id: deposit.id,
      txDate: deposit.txDate,
      txType: toDepositTxType(deposit.txType),
      txTypeLabel: deposit.txType,
      accountNo: deposit.accountNo,
      accountName: deposit.accountName,
      // PII 4종은 DB 에 암호문으로 있다. 복호화 실패 시 원본을 돌려주는 safe 계열을 쓰는 것은
      // 키 교체 이전 데이터가 섞여도 목록 전체가 죽지 않게 하려는 레포 관례다.
      depositor: this.cryptoCipher.safeDecryptDeliveryTarget(deposit.depositor) ?? '',
      depositorRaw: this.cryptoCipher.safeDecryptDeliveryTarget(deposit.depositorRaw),
      erpPartnerCode: this.cryptoCipher.safeDecryptDeliveryTarget(deposit.erpPartnerCode),
      erpPartnerName: this.cryptoCipher.safeDecryptDeliveryTarget(deposit.erpPartnerName),
      // BIGINT 는 드라이버가 string 으로 준다. 원화 금액은 안전 정수 범위를 넘지 않아 number 로 변환한다.
      amount: Number(deposit.amount),
      balance: Number(deposit.balance),
      voucherNo: deposit.voucherNo,
      matchStatus: deposit.matchStatus,
      matchedOwnerType: deposit.matchedOwnerType,
      matchedOwnerId: deposit.matchedOwnerId,
      matchedOwnerName:
        deposit.matchedOwnerType !== null && deposit.matchedOwnerId !== null
          ? (ownerNameMap.get(ownerKey(deposit.matchedOwnerType, deposit.matchedOwnerId)) ?? null)
          : null,
      scrapedAt: deposit.sourceScrapedAt,
    }));

    const totalPage = Math.ceil(totalCount / take);

    return { list, totalCount, totalPage, currentPage: page };
  }

  /**
   * 계좌 필터 드롭다운용 목록.
   *
   * bank_deposit 은 계좌 마스터 테이블이 아니라 거래 미러라서, 계좌 목록은 실제 거래에
   * 등장한 값을 집계해서 얻는다. account_name 은 계좌마다 하나로 고정된 값이 아니라
   * ECOUNT 표기 그대로라 대표값 하나만 골라 라벨 보조로 쓴다(식별은 account_no).
   * 계좌번호는 ECOUNT 가 이미 마스킹한 값이라 암호화 대상이 아니다.
   */
  async getAccountList(): Promise<DepositGetAccountListResDto> {
    const rows = await this.bankDepositRepository
      .createQueryBuilder('deposit')
      .select('deposit.accountNo', 'accountNo')
      .addSelect('MAX(deposit.account_name)', 'accountName')
      .addSelect('COUNT(*)', 'count')
      .groupBy('deposit.account_no')
      .orderBy('COUNT(*)', 'DESC')
      .getRawMany<{ accountNo: string; accountName: string | null; count: string }>();

    const accounts: DepositAccountViewDto[] = rows.map((row) => ({
      accountNo: row.accountNo,
      accountName: row.accountName,
      count: Number(row.count),
    }));

    return { accounts };
  }

  /**
   * 입금처 부분검색을 암호화 컬럼 위에서 성립시킨다.
   *
   * 암호문에는 LIKE 를 걸 수 없다. 대신 저장 스킴이 **결정론적**(고정 IV)이라 같은 평문이 늘
   * 같은 암호문이 되므로, 고유 암호문 목록을 뽑아 복호화한 뒤 평문으로 부분일치를 판정하고
   * 살아남은 암호문으로 되짚는다. 고유 입금처는 거래 건수보다 훨씬 적어(실측 4,893건 → 1,133개)
   * 이 왕복이 감당된다. 규모가 크게 늘면 캐시나 검색 전용 구조를 다시 검토해야 한다.
   */
  private async resolveDepositorCiphers(keyword: string): Promise<string[]> {
    const rows = await this.bankDepositRepository
      .createQueryBuilder('deposit')
      .select('DISTINCT deposit.depositor', 'depositor')
      .getRawMany<{ depositor: string }>();

    const needle = keyword.trim().toLowerCase();

    return rows
      .filter((row) => {
        const plain = this.cryptoCipher.safeDecryptDeliveryTarget(row.depositor);
        return plain !== null && plain.toLowerCase().includes(needle);
      })
      .map((row) => row.depositor);
  }

  /**
   * 페이지에 등장한 매칭 대상의 표시명을 한 번에 읽는다.
   *
   * ⚠️ **지갑 주인 단위가 확장될 때 손대야 할 유일한 지점이다.**
   * 표시명이 나오는 테이블은 타입마다 다르므로(SETTLEMENT_CODE → user_company,
   * 다른 타입 → 각자의 마스터) 타입이 늘면 여기에 분기를 추가한다. 지금은 해석 가능한
   * 타입이 SETTLEMENT_CODE 하나뿐이라, 그 외 타입은 이름 없이(null) 코드만 노출된다.
   *
   * matched_owner_id 는 FK 제약 없는 논리 참조라 엔티티 관계로 JOIN 할 수 없다.
   * 행마다 조회하면 N+1 이 되고, 매칭 기능이 가동 전이라 대부분의 페이지는 값이 전부 NULL
   * 이므로 그 경우 추가 쿼리 자체가 발생하지 않는다.
   */
  private async loadMatchedOwnerNames(depositList: BankDepositEntity[]): Promise<Map<string, string | null>> {
    const codes = [
      ...new Set(
        depositList
          .filter((deposit) => deposit.matchedOwnerType === SETTLEMENT_CODE_OWNER_TYPE)
          .map((deposit) => deposit.matchedOwnerId)
          .filter((code): code is string => code !== null),
      ),
    ];

    if (codes.length === 0) {
      return new Map();
    }

    const rows = await this.walletAccountRepository
      .createQueryBuilder('wallet')
      .leftJoin(UserCompanyEntity, 'company', 'company.id = wallet.ownerCompanyId')
      .select('wallet.ownerId', 'settlementCode')
      .addSelect('company.businessName', 'businessName')
      .where('wallet.ownerType = :ownerType', { ownerType: SETTLEMENT_CODE_OWNER_TYPE })
      .andWhere('wallet.ownerId IN (:...codes)', { codes })
      .getRawMany<{ settlementCode: string; businessName: string | null }>();

    return new Map(rows.map((row) => [ownerKey(SETTLEMENT_CODE_OWNER_TYPE, row.settlementCode), row.businessName]));
  }

  /**
   * 입금처(예금주 실명) 검색을 감사 로그에 남긴다.
   *
   * 로그 적재 실패가 조회 자체를 막으면 안 되므로 삼키고 에러 로그만 남긴다(환불 목록의
   * PII_SEARCH 기록과 동일한 패턴). 검색어는 마스킹해서 저장한다 — 감사 로그가 또 하나의
   * 평문 PII 저장소가 되면 안 된다.
   *
   * ⚠️ 마스킹은 maskPersonName 을 쓴다. 환불 목록이 쓰는 maskDeliveryTarget 은 값이 전화번호나
   * 이메일이라는 전제로 숫자만 추출하므로, 사람/회사 이름을 넣으면 전부 '****' 가 되어
   * "무엇을 검색했는가"가 통째로 사라진다(감사 로그의 존재 이유가 없어진다).
   * 같은 PII_SEARCH 라도 검색 대상의 종류가 다르면 마스킹도 달라야 한다.
   */
  private async recordPiiSearchLog(rawKeyword: string, audit: DepositListAuditContext): Promise<void> {
    const { user, ipAddress, userAgent } = audit;

    try {
      await this.activityLogService.createLog({
        userId: user.id,
        userEmail: user.email,
        method: 'GET',
        requestUrl: '/deposit/list',
        actionType: ActivityLogActionType.PII_SEARCH,
        ipAddress,
        userAgent,
        statusCode: 200,
        result: ActivityLogResult.SUCCESS,
        responseTime: 0,
        requestParams: {
          screen: 'DEPOSIT_HISTORY',
          searchType: 'depositor',
          maskedKeyword: MaskingUtil.maskPersonName(rawKeyword),
        },
      });
    } catch (error) {
      this.logger.error('Failed to record PII_SEARCH activity log', error instanceof Error ? error.stack : error);
    }
  }
}
