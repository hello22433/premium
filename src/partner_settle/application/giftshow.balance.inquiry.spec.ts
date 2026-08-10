import { GiftShowBalanceInquiry } from './giftshow.balance.inquiry';

describe('GiftShowBalanceInquiry', () => {
  const getCompanyBalance = jest.fn();
  const sut = new GiftShowBalanceInquiry({ getCompanyBalance } as any);

  beforeEach(() => {
    getCompanyBalance.mockReset();
  });

  it('KT알파 사용가능금액을 여신 표 잔액으로 반환한다', async () => {
    getCompanyBalance.mockResolvedValue({
      resCode: '0000',
      resMsg: '정상',
      pointCompanyBalance: { loanLimit: '100000', usePosblAmt: '001250' },
    });

    await expect(sut.getBalances(1)).resolves.toEqual([
      expect.objectContaining({ subItemKey: 'NONE', status: 'AVAILABLE', balance: '1250' }),
    ]);
  });

  it.each([
    ['API 오류 응답', { resCode: '9999', resMsg: '오류' }],
    ['잔액 누락', { resCode: '0000', resMsg: '정상', pointCompanyBalance: undefined }],
    ['음수 잔액', { resCode: '0000', resMsg: '정상', pointCompanyBalance: { usePosblAmt: '-1' } }],
  ])('%s은 FAILED로 fail-closed 한다', async (_name, response) => {
    getCompanyBalance.mockResolvedValue(response);

    await expect(sut.getBalances(1)).resolves.toEqual([
      expect.objectContaining({ subItemKey: 'NONE', status: 'FAILED', balance: null }),
    ]);
  });

  it('호출 예외는 FAILED로 반환한다', async () => {
    getCompanyBalance.mockRejectedValue(new Error('timeout'));

    await expect(sut.getBalances(1)).resolves.toEqual([
      expect.objectContaining({ status: 'FAILED', balance: null, reason: expect.stringContaining('timeout') }),
    ]);
  });
});
