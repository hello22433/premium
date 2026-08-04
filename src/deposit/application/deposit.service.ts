import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { BankDepositEntity } from '../../entity/bank.deposit.entity';
import { UserEntity } from '../../entity/user.entity';
import { DepositGetListReqQueryDto } from '../api/deposit.req.dto';
import {
  DepositAccountViewDto,
  DepositGetAccountListResDto,
  DepositGetListResDto,
  DepositViewDto,
} from '../api/deposit.res.dto';
import { DEPOSIT_TX_TYPE_TO_DB, toDepositTxType } from '../interface/deposit.tx.type';

/** matched_user_id → 고객명 조회 결과 (페이지에 등장한 id 만 담는다) */
type MatchedUserView = { businessName: string | null; personName: string | null };

/**
 * 입금내역 조회 서비스.
 *
 * 읽는 대상은 프리미엄이 소유한 미러 테이블이다. 그 테이블을 채우는 쪽은
 * DepositSyncService(erp_macro 조회 API 를 주기적으로 호출)이며, 이 서비스는 SELECT 만 한다.
 */
@Injectable()
export class DepositService {
  constructor(
    @InjectRepository(BankDepositEntity)
    private bankDepositRepository: Repository<BankDepositEntity>,
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
  ) {}

  async getList(getQuery: DepositGetListReqQueryDto): Promise<DepositGetListResDto> {
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
      queryBuilder = queryBuilder.andWhere('deposit.depositor LIKE :depositor', { depositor: `%${depositor}%` });
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
    const matchedUserMap = await this.loadMatchedUsers(depositList);

    const list: DepositViewDto[] = depositList.map((deposit) => {
      const matchedUser = deposit.matchedUserId !== null ? matchedUserMap.get(deposit.matchedUserId) : undefined;

      return {
        id: deposit.id,
        txDate: deposit.txDate,
        txType: toDepositTxType(deposit.txType),
        txTypeLabel: deposit.txType,
        accountNo: deposit.accountNo,
        accountName: deposit.accountName,
        depositor: deposit.depositor,
        depositorRaw: deposit.depositorRaw,
        erpPartnerCode: deposit.erpPartnerCode,
        erpPartnerName: deposit.erpPartnerName,
        // BIGINT 는 드라이버가 string 으로 준다. 원화 금액은 안전 정수 범위를 넘지 않아 number 로 변환한다.
        amount: Number(deposit.amount),
        balance: Number(deposit.balance),
        voucherNo: deposit.voucherNo,
        matchStatus: deposit.matchStatus,
        matchedUserId: deposit.matchedUserId,
        matchedBusinessName: matchedUser?.businessName ?? null,
        matchedPersonName: matchedUser?.personName ?? null,
        scrapedAt: deposit.sourceScrapedAt,
      };
    });

    const totalPage = Math.ceil(totalCount / take);

    return { list, totalCount, totalPage, currentPage: page };
  }

  /**
   * 계좌 필터 드롭다운용 목록.
   *
   * bank_deposit 은 계좌 마스터 테이블이 아니라 거래 미러라서, 계좌 목록은 실제 거래에
   * 등장한 값을 집계해서 얻는다. account_name 은 계좌마다 하나로 고정된 값이 아니라
   * ECOUNT 표기 그대로라 대표값 하나만 골라 라벨 보조로 쓴다(식별은 account_no).
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
   * 페이지에 등장한 matched_user_id 만 모아 한 번에 고객명을 읽는다.
   *
   * bank_deposit.matched_user_id 는 FK 제약 없는 논리 참조라 엔티티 관계로 JOIN 할 수
   * 없다. 행마다 조회하면 N+1 이 되고, 매핑 기능이 가동 전이라 대부분의 페이지는
   * matched_user_id 가 전부 NULL 이므로 이 경우 추가 쿼리 자체가 발생하지 않는다.
   */
  private async loadMatchedUsers(depositList: BankDepositEntity[]): Promise<Map<number, MatchedUserView>> {
    const matchedUserIds = [
      ...new Set(depositList.map((deposit) => deposit.matchedUserId).filter((id): id is number => id !== null)),
    ];

    if (matchedUserIds.length === 0) {
      return new Map();
    }

    const users = await this.userRepository.find({
      where: { id: In(matchedUserIds) },
      relations: ['company'],
    });

    return new Map(
      users.map((user) => [
        user.id,
        { businessName: user.company?.businessName ?? null, personName: user.personName ?? null },
      ]),
    );
  }
}
