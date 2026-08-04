import { BadRequestException } from '@nestjs/common';
import { In } from 'typeorm';
import { DepositService } from './deposit.service';
import { DepositGetListReqQueryDto } from '../api/deposit.req.dto';
import { DepositMatchStatus } from '../interface/deposit.match.status';
import { DepositTxType } from '../interface/deposit.tx.type';
import { BankDepositEntity } from '../../entity/bank.deposit.entity';

/**
 * 입금내역 조회 서비스 회귀 테스트.
 *
 * 이 화면의 결함은 대부분 "표시가 조용히 틀리는" 종류라 눈으로는 안 잡힌다. 그래서
 * 값이 왜곡될 수 있는 지점만 골라 고정한다.
 *  · BIGINT(amount/balance)는 드라이버가 string 으로 준다 → number 로 변환되는지
 *  · tx_date 는 'yyyy-MM-dd' 문자열 그대로 나가야 한다(Date 로 감싸면 하루 밀림)
 *  · tx_date 동률이 대량이라 id 타이브레이커가 없으면 페이지 경계에서 행이 샌다
 *  · tx_type 은 DB 한글 ↔ API 영문 번역이 한 곳에서만 일어나야 한다
 *  · matched_user_id 가 전부 NULL 인 현재 데이터에서 불필요한 고객 조회가 없어야 한다
 */
describe('DepositService.getList', () => {
  const buildQbSpy = (rows: Partial<BankDepositEntity>[] = [], totalCount = rows.length) => {
    const andWhereCalls: [string, Record<string, unknown>][] = [];
    const orderByCalls: [string, string][] = [];
    const qb: any = {
      andWhere: jest.fn((clause: string, params: Record<string, unknown>) => {
        andWhereCalls.push([clause, params]);
        return qb;
      }),
      orderBy: jest.fn((column: string, direction: string) => {
        orderByCalls.push([column, direction]);
        return qb;
      }),
      addOrderBy: jest.fn((column: string, direction: string) => {
        orderByCalls.push([column, direction]);
        return qb;
      }),
      take: jest.fn(() => qb),
      skip: jest.fn(() => qb),
      getManyAndCount: jest.fn(async () => [rows, totalCount]),
    };
    return { qb, andWhereCalls, orderByCalls };
  };

  const makeSut = (qb: any, userRepository: any = { find: jest.fn(async () => []) }) => {
    const bankDepositRepository = { createQueryBuilder: jest.fn(() => qb) } as any;
    return { sut: new DepositService(bankDepositRepository, userRepository), userRepository };
  };

  const query = (overrides: Partial<DepositGetListReqQueryDto> = {}): DepositGetListReqQueryDto =>
    ({ page: 1, take: 10, ...overrides }) as DepositGetListReqQueryDto;

  const row = (overrides: Partial<BankDepositEntity> = {}): Partial<BankDepositEntity> => ({
    id: 425,
    dedupKey: 'f57b73d0',
    txDate: '2026-07-29',
    txType: '입금',
    accountNo: '280***01757104',
    accountName: '(주)모바일이앤엠애드',
    erpPartnerCode: null,
    erpPartnerName: null,
    depositor: '두성종이',
    depositorRaw: '(가상)  두성종이',
    amount: '350000',
    balance: '45717465',
    voucherNo: '2026/07/29-2',
    matchedUserId: null,
    matchStatus: DepositMatchStatus.UNMATCHED,
    sourceScrapedAt: new Date('2026-08-03T01:35:51.995Z'),
    syncedAt: new Date('2026-08-03T02:00:00.000Z'),
    ...overrides,
  });

  describe('값 변환', () => {
    it('BIGINT 문자열로 온 amount/balance 를 number 로 변환한다', async () => {
      const { qb } = buildQbSpy([row()]);
      const { sut } = makeSut(qb);

      const result = await sut.getList(query());

      expect(result.list[0].amount).toBe(350000);
      expect(result.list[0].balance).toBe(45717465);
    });

    it("tx_date 를 'yyyy-MM-dd' 문자열 그대로 내보낸다 (Date 변환 시 하루 밀림)", async () => {
      const { qb } = buildQbSpy([row({ txDate: '2026-07-29' })]);
      const { sut } = makeSut(qb);

      const result = await sut.getList(query());

      expect(result.list[0].txDate).toBe('2026-07-29');
    });

    it('DB 한글 구분값을 API 영문 키로 번역하고 원문도 함께 내보낸다', async () => {
      const { qb } = buildQbSpy([row({ txType: '출금' })]);
      const { sut } = makeSut(qb);

      const result = await sut.getList(query());

      expect(result.list[0].txType).toBe(DepositTxType.WITHDRAW);
      expect(result.list[0].txTypeLabel).toBe('출금');
    });

    it('예상 밖의 구분값은 임의로 접지 않고 null 로 두되 원문은 보존한다', async () => {
      const { qb } = buildQbSpy([row({ txType: '이체' })]);
      const { sut } = makeSut(qb);

      const result = await sut.getList(query());

      expect(result.list[0].txType).toBeNull();
      expect(result.list[0].txTypeLabel).toBe('이체');
    });
  });

  describe('정렬', () => {
    it('거래일자 DESC 뒤에 id DESC 타이브레이커를 붙인다', async () => {
      const { qb, orderByCalls } = buildQbSpy();
      const { sut } = makeSut(qb);

      await sut.getList(query());

      expect(orderByCalls).toEqual([
        ['deposit.txDate', 'DESC'],
        ['deposit.id', 'DESC'],
      ]);
    });
  });

  describe('필터', () => {
    it('기간 필터는 경계일을 포함한다 (>= startAt, <= endAt)', async () => {
      const { qb, andWhereCalls } = buildQbSpy();
      const { sut } = makeSut(qb);

      await sut.getList(query({ startAt: '2026-07-01', endAt: '2026-07-31' }));

      expect(andWhereCalls).toContainEqual(['deposit.txDate >= :startAt', { startAt: '2026-07-01' }]);
      expect(andWhereCalls).toContainEqual(['deposit.txDate <= :endAt', { endAt: '2026-07-31' }]);
    });

    it('구분 필터는 영문 키를 DB 한글 값으로 번역해 넘긴다', async () => {
      const { qb, andWhereCalls } = buildQbSpy();
      const { sut } = makeSut(qb);

      await sut.getList(query({ txType: DepositTxType.WITHDRAW }));

      expect(andWhereCalls).toContainEqual(['deposit.txType = :txType', { txType: '출금' }]);
    });

    it('입금처는 부분일치, 계좌번호는 전체일치로 조회한다', async () => {
      const { qb, andWhereCalls } = buildQbSpy();
      const { sut } = makeSut(qb);

      await sut.getList(query({ depositor: '두성', accountNo: '280***01757104' }));

      expect(andWhereCalls).toContainEqual(['deposit.depositor LIKE :depositor', { depositor: '%두성%' }]);
      expect(andWhereCalls).toContainEqual(['deposit.accountNo = :accountNo', { accountNo: '280***01757104' }]);
    });

    it('필터를 주지 않으면 조건 없이 전체를 조회한다', async () => {
      const { qb, andWhereCalls } = buildQbSpy();
      const { sut } = makeSut(qb);

      await sut.getList(query());

      expect(andWhereCalls).toHaveLength(0);
    });

    it('시작일이 종료일보다 늦으면 빈 목록 대신 400 으로 끊는다', async () => {
      const { qb } = buildQbSpy();
      const { sut } = makeSut(qb);

      await expect(sut.getList(query({ startAt: '2026-07-31', endAt: '2026-07-01' }))).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(qb.getManyAndCount).not.toHaveBeenCalled();
    });
  });

  describe('페이징', () => {
    it('page/take 로 skip 을 계산하고 전체 페이지 수를 올림한다', async () => {
      const { qb } = buildQbSpy([row()], 25);
      const { sut } = makeSut(qb);

      const result = await sut.getList(query({ page: 3, take: 10 }));

      expect(qb.take).toHaveBeenCalledWith(10);
      expect(qb.skip).toHaveBeenCalledWith(20);
      expect(result).toMatchObject({ totalCount: 25, totalPage: 3, currentPage: 3 });
    });
  });

  describe('고객명 조인', () => {
    it('matched_user_id 가 전부 NULL 이면 고객 조회를 아예 하지 않는다', async () => {
      const { qb } = buildQbSpy([row({ matchedUserId: null })]);
      const { sut, userRepository } = makeSut(qb);

      const result = await sut.getList(query());

      expect(userRepository.find).not.toHaveBeenCalled();
      expect(result.list[0].matchedBusinessName).toBeNull();
      expect(result.list[0].matchedPersonName).toBeNull();
    });

    it('매칭된 행이 있으면 중복 없는 id 목록으로 한 번만 조회해 고객명을 채운다', async () => {
      const { qb } = buildQbSpy([
        row({ id: 1, matchedUserId: 7 }),
        row({ id: 2, matchedUserId: 7 }),
        row({ id: 3, matchedUserId: null }),
      ]);
      let findArg: any;
      const userRepository = {
        find: jest.fn(async (arg: any) => {
          findArg = arg;
          return [{ id: 7, personName: '홍길동', company: { businessName: '두성종이' } }];
        }),
      };
      const { sut } = makeSut(qb, userRepository);

      const result = await sut.getList(query());

      expect(userRepository.find).toHaveBeenCalledTimes(1);
      expect(findArg.where.id).toEqual(In([7]));
      expect(result.list[0].matchedBusinessName).toBe('두성종이');
      expect(result.list[0].matchedPersonName).toBe('홍길동');
      expect(result.list[2].matchedBusinessName).toBeNull();
    });

    it('매칭 id 가 가리키는 고객이 사라졌어도 목록은 깨지지 않는다 (FK 제약 없는 논리 참조)', async () => {
      const { qb } = buildQbSpy([row({ matchedUserId: 999 })]);
      const userRepository = { find: jest.fn(async () => []) };
      const { sut } = makeSut(qb, userRepository);

      const result = await sut.getList(query());

      expect(result.list[0].matchedUserId).toBe(999);
      expect(result.list[0].matchedBusinessName).toBeNull();
    });
  });
});

describe('DepositService.getAccountList', () => {
  it('계좌번호로 집계해 건수를 number 로 변환한다', async () => {
    const qb: any = {
      select: jest.fn(() => qb),
      addSelect: jest.fn(() => qb),
      groupBy: jest.fn(() => qb),
      orderBy: jest.fn(() => qb),
      getRawMany: jest.fn(async () => [
        { accountNo: '280***01757104', accountName: '(주)모바일이앤엠애드', count: '3867' },
        { accountNo: '131***40301018', accountName: '기업은행', count: '881' },
      ]),
    };
    const sut = new DepositService({ createQueryBuilder: jest.fn(() => qb) } as any, {} as any);

    const result = await sut.getAccountList();

    expect(result.accounts).toEqual([
      { accountNo: '280***01757104', accountName: '(주)모바일이앤엠애드', count: 3867 },
      { accountNo: '131***40301018', accountName: '기업은행', count: 881 },
    ]);
  });
});
