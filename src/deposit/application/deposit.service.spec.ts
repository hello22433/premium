import { BadRequestException } from '@nestjs/common';
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
 *  · PII 4종은 DB 에 암호문으로 있다 → 응답에 암호문이 새어 나가면 안 된다
 *  · 암호문에는 LIKE 를 못 건다 → 입금처 부분검색이 다른 경로로 성립해야 한다
 *  · BIGINT(amount/balance)는 드라이버가 string 으로 준다 → number 로 변환되는지
 *  · tx_date 는 'yyyy-MM-dd' 문자열 그대로 나가야 한다(Date 로 감싸면 하루 밀림)
 *  · tx_date 동률이 대량이라 id 타이브레이커가 없으면 페이지 경계에서 행이 샌다
 *  · 귀속 단위는 고객이 아니라 정산코드다
 */
describe('DepositService.getList', () => {
  /** 테스트용 가짜 암호화 — 결정론적이고 되돌릴 수 있어 실제 스킴과 성질이 같다. */
  const enc = (plain: string) => `enc(${plain})`;
  const cryptoCipher = {
    encryptDeliveryTarget: jest.fn((plain: string) => enc(plain)),
    safeDecryptDeliveryTarget: jest.fn((cipher: string | null) =>
      cipher === null || cipher === undefined ? null : cipher.replace(/^enc\((.*)\)$/, '$1'),
    ),
  };

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
      select: jest.fn(() => qb),
      addSelect: jest.fn(() => qb),
      take: jest.fn(() => qb),
      skip: jest.fn(() => qb),
      getManyAndCount: jest.fn(async () => [rows, totalCount]),
      // 입금처 검색이 쓰는 DISTINCT 조회. 기본은 페이지에 등장한 암호문들.
      getRawMany: jest.fn(async () => rows.map((row) => ({ depositor: row.depositor }))),
    };
    return { qb, andWhereCalls, orderByCalls };
  };

  const makeSut = (qb: any, walletQb?: any) => {
    const bankDepositRepository = { createQueryBuilder: jest.fn(() => qb) } as any;
    const walletAccountRepository = {
      createQueryBuilder: jest.fn(() => walletQb ?? { getRawMany: jest.fn(async () => []) }),
    } as any;
    const activityLogService = { createLog: jest.fn(async () => 1) } as any;
    return {
      sut: new DepositService(bankDepositRepository, walletAccountRepository, cryptoCipher as any, activityLogService),
      walletAccountRepository,
      activityLogService,
    };
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
    depositor: enc('두성종이'),
    depositorRaw: enc('(가상)  두성종이'),
    amount: '350000',
    balance: '45717465',
    voucherNo: '2026/07/29-2',
    matchedOwnerType: null,
    matchedOwnerId: null,
    matchStatus: DepositMatchStatus.UNMATCHED,
    sourceScrapedAt: new Date('2026-08-03T01:35:51.995Z'),
    syncedAt: new Date('2026-08-03T02:00:00.000Z'),
    ...overrides,
  });

  beforeEach(() => jest.clearAllMocks());

  describe('PII 복호화', () => {
    it('암호문이 응답에 새어 나가지 않고 평문으로 나간다', async () => {
      const { qb } = buildQbSpy([
        row({ depositor: enc('두성종이'), depositorRaw: enc('(가상)  두성종이'), erpPartnerName: enc('두성종이(주)') }),
      ]);
      const { sut } = makeSut(qb);

      const result = await sut.getList(query());

      expect(result.list[0].depositor).toBe('두성종이');
      expect(result.list[0].depositorRaw).toBe('(가상)  두성종이');
      expect(result.list[0].erpPartnerName).toBe('두성종이(주)');
    });

    it('null 인 PII 는 null 그대로 둔다', async () => {
      const { qb } = buildQbSpy([row({ depositorRaw: null, erpPartnerCode: null })]);
      const { sut } = makeSut(qb);

      const result = await sut.getList(query());

      expect(result.list[0].depositorRaw).toBeNull();
      expect(result.list[0].erpPartnerCode).toBeNull();
    });
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

    it('계좌번호는 전체일치로 조회한다 (마스킹형이라 암호화 대상 아님)', async () => {
      const { qb, andWhereCalls } = buildQbSpy();
      const { sut } = makeSut(qb);

      await sut.getList(query({ accountNo: '280***01757104' }));

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

  /**
   * 암호문에는 LIKE 를 걸 수 없다. 저장 스킴이 결정론적이라 고유 암호문을 복호화해 평문으로
   * 부분일치를 판정하고, 살아남은 암호문으로 되짚는 경로가 성립해야 한다.
   */
  describe('입금처 부분검색 (암호화 컬럼)', () => {
    it('평문 부분일치로 걸러 낸 암호문들을 IN 으로 조회한다', async () => {
      const { qb, andWhereCalls } = buildQbSpy([row({ depositor: enc('두성종이') })]);
      qb.getRawMany.mockResolvedValue([
        { depositor: enc('두성종이') },
        { depositor: enc('두성상사') },
        { depositor: enc('한빛문구') },
      ]);
      const { sut } = makeSut(qb);

      await sut.getList(query({ depositor: '두성' }));

      expect(andWhereCalls).toContainEqual([
        'deposit.depositor IN (:...depositorCiphers)',
        { depositorCiphers: [enc('두성종이'), enc('두성상사')] },
      ]);
    });

    it('암호문에 LIKE 를 걸지 않는다', async () => {
      const { qb, andWhereCalls } = buildQbSpy([row()]);
      const { sut } = makeSut(qb);

      await sut.getList(query({ depositor: '두성' }));

      expect(andWhereCalls.some(([clause]) => clause.includes('LIKE'))).toBe(false);
    });

    it('일치하는 입금처가 없으면 빈 결과를 돌려준다 (IN () 는 SQL 오류)', async () => {
      const { qb } = buildQbSpy([row()]);
      qb.getRawMany.mockResolvedValue([{ depositor: enc('한빛문구') }]);
      const { sut } = makeSut(qb);

      const result = await sut.getList(query({ depositor: '없는이름' }));

      expect(result).toEqual({ list: [], totalCount: 0, totalPage: 0, currentPage: 1 });
      expect(qb.getManyAndCount).not.toHaveBeenCalled();
    });

    it('대소문자를 구분하지 않는다', async () => {
      const { qb, andWhereCalls } = buildQbSpy([row()]);
      qb.getRawMany.mockResolvedValue([{ depositor: enc('KB68416088') }]);
      const { sut } = makeSut(qb);

      await sut.getList(query({ depositor: 'kb684' }));

      expect(andWhereCalls).toContainEqual([
        'deposit.depositor IN (:...depositorCiphers)',
        { depositorCiphers: [enc('KB68416088')] },
      ]);
    });
  });

  describe('감사 로그', () => {
    const auditContext = {
      user: { id: 3, email: 'admin@test.local', authority: 'SUPER_ADMIN' } as any,
      ipAddress: '10.0.0.1',
      userAgent: 'jest',
    };

    it('입금처를 검색하면 PII_SEARCH 를 남기고 검색어는 마스킹한다', async () => {
      const { qb } = buildQbSpy([row()]);
      const { sut, activityLogService } = makeSut(qb);

      await sut.getList(query({ depositor: '두성' }), auditContext);

      expect(activityLogService.createLog).toHaveBeenCalledTimes(1);
      const logged = activityLogService.createLog.mock.calls[0][0];
      expect(logged).toMatchObject({
        userId: 3,
        actionType: 'PII_SEARCH',
        requestUrl: '/deposit/list',
        ipAddress: '10.0.0.1',
      });
      expect(logged.requestParams.maskedKeyword).not.toBe('두성');
    });

    it('검색 없이 목록만 보면 PII_SEARCH 를 남기지 않는다', async () => {
      const { qb } = buildQbSpy([row()]);
      const { sut, activityLogService } = makeSut(qb);

      await sut.getList(query(), auditContext);

      expect(activityLogService.createLog).not.toHaveBeenCalled();
    });

    it('감사 로그 적재가 실패해도 조회는 성공한다', async () => {
      const { qb } = buildQbSpy([row()]);
      const { sut, activityLogService } = makeSut(qb);
      activityLogService.createLog.mockRejectedValue(new Error('로그 DB 장애'));

      const result = await sut.getList(query({ depositor: '두성' }), auditContext);

      expect(result.list).toHaveLength(1);
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

  /** 귀속 단위는 고객(user)이 아니라 정산코드다 — 예치금 지갑이 정산코드 단위이기 때문. */
  describe('정산코드 귀속', () => {
    const buildWalletQb = (rows: { settlementCode: string; businessName: string | null }[]) => {
      const captured: { codes: string[] } = { codes: [] };
      const walletQb: any = {
        leftJoin: jest.fn(() => walletQb),
        select: jest.fn(() => walletQb),
        addSelect: jest.fn(() => walletQb),
        where: jest.fn(() => walletQb),
        andWhere: jest.fn((_clause: string, params: any) => {
          if (params?.codes) captured.codes = params.codes;
          return walletQb;
        }),
        getRawMany: jest.fn(async () => rows),
      };
      return { walletQb, captured };
    };

    it('매칭이 없으면 지갑 조회를 아예 하지 않는다', async () => {
      const { qb } = buildQbSpy([row({ matchedOwnerType: null, matchedOwnerId: null })]);
      const { sut, walletAccountRepository } = makeSut(qb);

      const result = await sut.getList(query());

      expect(walletAccountRepository.createQueryBuilder).not.toHaveBeenCalled();
      expect(result.list[0].matchedOwnerType).toBeNull();
      expect(result.list[0].matchedOwnerId).toBeNull();
      expect(result.list[0].matchedOwnerName).toBeNull();
    });

    it('매칭된 정산코드가 있으면 중복 없이 한 번만 조회해 홈 회사명을 채운다', async () => {
      const { qb } = buildQbSpy([
        row({ id: 1, matchedOwnerType: 'SETTLEMENT_CODE', matchedOwnerId: 'company-7' }),
        row({ id: 2, matchedOwnerType: 'SETTLEMENT_CODE', matchedOwnerId: 'company-7' }),
        row({ id: 3, matchedOwnerType: null, matchedOwnerId: null }),
      ]);
      const { walletQb, captured } = buildWalletQb([{ settlementCode: 'company-7', businessName: '두성종이' }]);
      const { sut, walletAccountRepository } = makeSut(qb, walletQb);

      const result = await sut.getList(query());

      expect(walletAccountRepository.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(captured.codes).toEqual(['company-7']);
      expect(result.list[0].matchedOwnerName).toBe('두성종이');
      expect(result.list[2].matchedOwnerName).toBeNull();
    });

    it('정산코드가 가리키는 지갑이 없어도 목록은 깨지지 않는다 (FK 제약 없는 논리 참조)', async () => {
      const { qb } = buildQbSpy([row({ matchedOwnerType: 'SETTLEMENT_CODE', matchedOwnerId: 'company-999' })]);
      const { walletQb } = buildWalletQb([]);
      const { sut } = makeSut(qb, walletQb);

      const result = await sut.getList(query());

      expect(result.list[0].matchedOwnerId).toBe('company-999');
      expect(result.list[0].matchedOwnerName).toBeNull();
    });

    // 지갑 주인 단위 확장 대비. 아직 이름을 해석할 수 없는 타입이 섞여 들어와도
    // (a) 정산코드로 오인해 지갑을 뒤지지 않고 (b) 목록이 죽지 않아야 한다.
    // 그 타입의 표시명 조회는 loadMatchedOwnerNames 에 분기를 추가하는 시점에 붙는다.
    it('아직 지원하지 않는 주인 타입은 지갑 조회 없이 식별자만 노출한다', async () => {
      const { qb } = buildQbSpy([
        row({ id: 1, matchedOwnerType: 'PARTNER' as never, matchedOwnerId: 'p-7' }),
        row({ id: 2, matchedOwnerType: 'SETTLEMENT_CODE', matchedOwnerId: 'company-7' }),
      ]);
      const { walletQb, captured } = buildWalletQb([{ settlementCode: 'company-7', businessName: '두성종이' }]);
      const { sut } = makeSut(qb, walletQb);

      const result = await sut.getList(query());

      // 미지원 타입의 id 가 정산코드 조회 조건에 섞여 들어가지 않는다
      expect(captured.codes).toEqual(['company-7']);
      expect(result.list[0].matchedOwnerType).toBe('PARTNER');
      expect(result.list[0].matchedOwnerId).toBe('p-7');
      expect(result.list[0].matchedOwnerName).toBeNull();
      expect(result.list[1].matchedOwnerName).toBe('두성종이');
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
    const sut = new DepositService({ createQueryBuilder: jest.fn(() => qb) } as any, {} as any, {} as any, {} as any);

    const result = await sut.getAccountList();

    expect(result.accounts).toEqual([
      { accountNo: '280***01757104', accountName: '(주)모바일이앤엠애드', count: 3867 },
      { accountNo: '131***40301018', accountName: '기업은행', count: 881 },
    ]);
  });
});