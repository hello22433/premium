// 실제 DB 연결 없는 단위 테스트이므로 typeorm-transactional 데코레이터를 no-op 으로 mock 한다.
jest.mock('typeorm-transactional', () => ({
  Transactional: () => (_target: unknown, _key: unknown, _descriptor: unknown) => _descriptor,
  IsolationLevel: { READ_COMMITTED: 'READ COMMITTED' },
  Propagation: { REQUIRED: 'REQUIRED', REQUIRES_NEW: 'REQUIRES_NEW' },
  initializeTransactionalContext: jest.fn(),
  addTransactionalDataSources: jest.fn(),
}));

import { BadRequestException } from '@nestjs/common';
import { ProductService } from './product.service';

/**
 * 신세계 유의사항 조회/수정 회귀 테스트.
 *
 * 이 문구는 발송 문자와 쿠폰 페이지가 함께 읽는 정본이라, 운영자가 화면에서 저장한 모양이
 * 한 글자도 달라지면 안 된다. 특히 줄바꿈과 빈 줄이 문자 본문의 문단 배치를 결정한다.
 *
 * 생성자 의존성이 많아 Object.create 로 우회 후 협력자만 mock 주입한다.
 */
describe('ProductService — 신세계 유의사항', () => {
  const user = { id: 7, email: 'ops@epopkon.com' } as any;

  const makeSut = (products: any[], lastHistory: any = null) => {
    const builder: any = {
      innerJoin: jest.fn(() => builder),
      where: jest.fn(() => builder),
      andWhere: jest.fn(() => builder),
      orderBy: jest.fn(() => builder),
      setLock: jest.fn(() => builder),
      getMany: jest.fn(() => Promise.resolve(products)),
    };

    const sut: any = Object.create(ProductService.prototype);
    sut.productRepository = {
      createQueryBuilder: jest.fn(() => builder),
      update: jest.fn().mockResolvedValue(undefined),
    };
    sut.productUpdateHistoryRepository = {
      findOne: jest.fn().mockResolvedValue(lastHistory),
      insert: jest.fn().mockResolvedValue(undefined),
    };
    return sut;
  };

  describe('getSsgNotice', () => {
    it('가장 오래된 상품의 문구를 정본으로 내려주고 사용 권종 수를 함께 알려준다', async () => {
      const sut = makeSut([
        { id: 1, memo: '유의사항 본문' },
        { id: 2, memo: '유의사항 본문' },
      ]);

      const result = await sut.getSsgNotice();

      expect(result.notice).toBe('유의사항 본문');
      expect(result.productCount).toBe(2);
      expect(result.distinctNoticeCount).toBe(1);
      expect(result.noticeByteLength).toBe(Buffer.byteLength('유의사항 본문', 'utf8'));
    });

    it('권종별 문구가 갈라져 있으면 종류 수를 알려 화면이 경고할 수 있게 한다', async () => {
      const sut = makeSut([
        { id: 1, memo: '구문구' },
        { id: 2, memo: '신문구' },
      ]);

      const result = await sut.getSsgNotice();

      expect(result.notice).toBe('구문구');
      expect(result.distinctNoticeCount).toBe(2);
    });

    it('마지막 수정자·수정일시를 함께 내려준다', async () => {
      const sut = makeSut([{ id: 1, memo: '문구' }], {
        createdAt: new Date('2026-08-12T15:10:08'),
        user: { email: 'ops@epopkon.com' },
      });

      const result = await sut.getSsgNotice();

      expect(result.lastUpdatedAt).toBe('2026-08-12T15:10:08');
      expect(result.lastUpdatedUserName).toBe('ops@epopkon.com');
    });

    it('수정 이력이 없으면 마지막 수정 정보는 null 이다', async () => {
      const sut = makeSut([{ id: 1, memo: '문구' }]);

      const result = await sut.getSsgNotice();

      expect(result.lastUpdatedAt).toBeNull();
      expect(result.lastUpdatedUserName).toBeNull();
    });

    it('신세계 상품이 하나도 없으면 400', async () => {
      const sut = makeSut([]);

      await expect(sut.getSsgNotice()).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('updateSsgNotice', () => {
    it('모든 권종에 같은 문구를 저장하고 상품별 수정 이력을 남긴다', async () => {
      const sut = makeSut([
        { id: 1, memo: '구문구' },
        { id: 2, memo: '구문구' },
      ]);

      const result = await sut.updateSsgNotice(user, { notice: '신문구', reason: '문구 개정' });

      expect(sut.productRepository.update).toHaveBeenCalledWith({ id: expect.anything() }, { memo: '신문구' });
      const [[histories]] = sut.productUpdateHistoryRepository.insert.mock.calls;
      expect(histories).toHaveLength(2);
      expect(histories[0]).toMatchObject({
        productId: 1,
        userId: 7,
        key: 'memo',
        keyName: '유의사항',
        beforeValue: '구문구',
        afterValue: '신문구',
        reason: '문구 개정',
      });
      expect(result.notice).toBe('신문구');
      expect(result.distinctNoticeCount).toBe(1);
    });

    it('줄바꿈과 빈 줄을 입력한 그대로 저장한다', async () => {
      const sut = makeSut([{ id: 1, memo: null }]);
      const notice = '도입문장입니다\n\n▷교환처: 전국 이마트 키오스크\n\n▷유의사항\n- 첫째 줄\n- 둘째 줄';

      const result = await sut.updateSsgNotice(user, { notice });

      expect(sut.productRepository.update).toHaveBeenCalledWith(expect.anything(), { memo: notice });
      expect(result.notice).toBe(notice);
    });

    it('브라우저가 보낸 CRLF 줄바꿈은 LF 로만 통일하고 내용은 건드리지 않는다', async () => {
      const sut = makeSut([{ id: 1, memo: null }]);

      await sut.updateSsgNotice(user, { notice: '도입문장\r\n\r\n▷유의사항\r\n- 첫째 줄' });

      expect(sut.productRepository.update).toHaveBeenCalledWith(expect.anything(), {
        memo: '도입문장\n\n▷유의사항\n- 첫째 줄',
      });
    });

    it('앞뒤 공백과 들여쓰기는 임의로 지우지 않는다', async () => {
      const sut = makeSut([{ id: 1, memo: null }]);
      const notice = '  들여쓴 도입문장  \n\n   - 들여쓴 항목';

      await sut.updateSsgNotice(user, { notice });

      expect(sut.productRepository.update).toHaveBeenCalledWith(expect.anything(), { memo: notice });
    });

    it('내용이 같으면 저장도 이력도 남기지 않는다', async () => {
      const sut = makeSut([{ id: 1, memo: '같은 문구' }]);

      await sut.updateSsgNotice(user, { notice: '같은 문구' });

      expect(sut.productRepository.update).not.toHaveBeenCalled();
      expect(sut.productUpdateHistoryRepository.insert).not.toHaveBeenCalled();
    });

    it('공백·줄바꿈만 있는 문구는 400 으로 막는다', async () => {
      const sut = makeSut([{ id: 1, memo: '기존 문구' }]);

      await expect(sut.updateSsgNotice(user, { notice: '  \r\n \n  ' })).rejects.toBeInstanceOf(BadRequestException);
      expect(sut.productRepository.update).not.toHaveBeenCalled();
    });

    it('4000자를 넘는 문구는 400 으로 막는다', async () => {
      const sut = makeSut([{ id: 1, memo: '기존 문구' }]);

      await expect(sut.updateSsgNotice(user, { notice: '가'.repeat(4001) })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(sut.productRepository.update).not.toHaveBeenCalled();
    });

    it('이모지 4000개는 코드포인트 기준 4000자이므로 허용한다 (UTF-16 아님)', async () => {
      // '😀'.length === 2 (UTF-16 surrogate pair) 이지만 코드포인트는 1이다.
      // MySQL varchar(4000) 도 코드포인트 단위이므로 같은 기준을 쓰야 한다.
      const sut = makeSut([{ id: 1, memo: null }]);
      const emojiNotice = '\ud83d\ude00'.repeat(4000);

      expect(emojiNotice.length).toBe(8000); // UTF-16
      expect([...emojiNotice].length).toBe(4000); // 코드포인트

      await sut.updateSsgNotice(user, { notice: emojiNotice });

      expect(sut.productRepository.update).toHaveBeenCalledWith(expect.anything(), { memo: emojiNotice });
    });

    it('이모지 4001개는 코드포인트 기준 초과로 400', async () => {
      const sut = makeSut([{ id: 1, memo: null }]);

      await expect(sut.updateSsgNotice(user, { notice: '\ud83d\ude00'.repeat(4001) })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('동시 수정 시 두 번째 트랜잭션의 beforeValue 는 첫 번째가 저장한 값이어야 한다', async () => {
      // SSG 조회에 pessimistic_write 락이 걸리는지 확인하는 구조 테스트.
      // 실제 동시성은 DB 통합 테스트에서 검증하지만, 동일 트랜잭션 내에서
      // setLock(\'pessimistic_write\') 호출이 뽠지면 대응이 없으므로 회귀로 잡는다.
      const sut = makeSut([{ id: 1, memo: 'O' }]);

      await sut.updateSsgNotice(user, { notice: 'A' });

      const builder = sut.productRepository.createQueryBuilder();
      expect(builder.setLock).toHaveBeenCalledWith('pessimistic_write');
    });

    it('신세계 상품이 하나도 없으면 400', async () => {
      const sut = makeSut([]);

      await expect(sut.updateSsgNotice(user, { notice: '문구' })).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
