import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DepositGetListReqQueryDto } from './deposit.req.dto';
import { DepositMatchStatus } from '../interface/deposit.match.status';
import { DepositTxType } from '../interface/deposit.tx.type';

/**
 * 입금내역 목록 쿼리 DTO 검증.
 *
 * 이 엔드포인트의 입력은 전부 쿼리스트링(문자열)이라, 형식 검증이 없으면 잘못된 값이
 * 그대로 WHERE 절에 실려 "조건이 무시된 채 전체가 조회되는" 형태로 조용히 새어나간다.
 * 특히 날짜는 형식이 어긋나면 MySQL 이 비교를 포기해 필터가 사라지므로 형식을 고정한다.
 */
describe('DepositGetListReqQueryDto', () => {
  const build = (query: Record<string, unknown>) =>
    plainToInstance(DepositGetListReqQueryDto, query, { enableImplicitConversion: false });

  const errorsOf = async (query: Record<string, unknown>) => {
    const errors = await validate(build(query));
    return errors.map((e) => e.property);
  };

  describe('기본값', () => {
    it('아무것도 주지 않으면 page=1, take=10 으로 통과한다', async () => {
      const dto = build({});

      expect(await validate(dto)).toHaveLength(0);
      expect(dto.page).toBe(1);
      expect(dto.take).toBe(10);
    });
  });

  describe('날짜 형식', () => {
    it.each(['2026-07-01', '2025-12-31'])('yyyy-MM-dd 형식(%s)은 통과한다', async (value) => {
      expect(await errorsOf({ startAt: value, endAt: value })).toHaveLength(0);
    });

    it.each(['2026-7-1', '20260701', 'yesterday', ''])('yyyy-MM-dd 가 아닌 값(%s)은 거부한다', async (value) => {
      expect(await errorsOf({ startAt: value })).toContain('startAt');
    });

    it('endAt 도 같은 형식 규칙을 적용한다', async () => {
      expect(await errorsOf({ endAt: '2026/07/01' })).toContain('endAt');
    });

    /**
     * 이 레포의 지배적 관례는 `yyyy-MM-ddTHH:mm:ss` 이고 정산관리 하위 화면들이 기간 필터에
     * T00:00:00 / T23:59:59 를 붙여 보낸다. 화면을 복붙했다고 400 이 나면 안 되므로 둘 다 받는다.
     * 대상 컬럼이 DATE 라 시각을 잘라도 경계일 포함 의미가 그대로 유지된다.
     */
    it.each([
      ['2026-07-01T00:00:00', '2026-07-01'],
      ['2026-07-31T23:59:59', '2026-07-31'],
      ['2026-07-01T00:00:00.000', '2026-07-01'],
    ])('시각이 붙어 와도(%s) 날짜만 취해 통과시킨다', async (input, expected) => {
      const dto = build({ startAt: input, endAt: input });

      expect(await validate(dto)).toHaveLength(0);
      expect(dto.startAt).toBe(expected);
      expect(dto.endAt).toBe(expected);
    });

    it('시각을 잘라낸 뒤에도 형식이 틀리면 거부한다', async () => {
      expect(await errorsOf({ startAt: 'abcT00:00:00' })).toContain('startAt');
    });
  });

  describe('열거값', () => {
    it.each(Object.values(DepositTxType))('구분 %s 은 통과한다', async (value) => {
      expect(await errorsOf({ txType: value })).toHaveLength(0);
    });

    it('DB 원문 한글을 그대로 보내면 거부한다 (API 계약은 영문 키)', async () => {
      expect(await errorsOf({ txType: '입금' })).toContain('txType');
    });

    it.each(Object.values(DepositMatchStatus))('매칭상태 %s 은 통과한다', async (value) => {
      expect(await errorsOf({ matchStatus: value })).toHaveLength(0);
    });

    it('정의되지 않은 매칭상태는 거부한다', async () => {
      expect(await errorsOf({ matchStatus: 'DONE' })).toContain('matchStatus');
    });
  });

  describe('검색어 길이', () => {
    it('대상 컬럼 길이(191)까지는 통과한다', async () => {
      expect(await errorsOf({ depositor: 'ㄱ'.repeat(191) })).toHaveLength(0);
    });

    it('191 자를 넘는 입금처 검색어는 거부한다', async () => {
      expect(await errorsOf({ depositor: 'ㄱ'.repeat(192) })).toContain('depositor');
    });

    it('50 자를 넘는 계좌번호는 거부한다', async () => {
      expect(await errorsOf({ accountNo: '1'.repeat(51) })).toContain('accountNo');
    });
  });

  describe('페이징 경계', () => {
    it('page 는 1 미만을 거부한다', async () => {
      expect(await errorsOf({ page: 0 })).toContain('page');
    });

    it('take 는 상한(1000)을 넘으면 거부한다', async () => {
      expect(await errorsOf({ take: 1001 })).toContain('take');
    });
  });
});
