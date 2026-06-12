import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { FindOperator } from 'typeorm';
import { OrderFromService } from './order.from.service';
import { IUserAuthority } from '../../user/interface/user.authority';
import { OrderFromRequestStatus } from '../interface/order.from.definition.type';

/**
 * P0 회귀 잠금 — 발신번호 관리 IDOR / 블랙리스트 / admin 필터.
 *
 * - getPhoneList / createPhone / setDefault 는 클래스 토큰 가드(AuthUserAuthorizationGuard)만
 *   걸려 있어, 인증된 누구나 임의 userId 를 전송하면 타 계정 번호를 열람/탈취할 수 있었다.
 * - 대리 권한(SUPER_ADMIN / OPERATION_ADMIN)은 타 userId 허용, CORPORATE_ADMIN(일반 고객사
 *   계정)은 자기 자신만 허용해야 한다 (프론트 canProxyOrder = authority !== CORPORATE_ADMIN 과 일치).
 * - createPhone 은 공용 대표번호(1644-3614)를 정규화 후 차단해야 한다.
 * - getAdminList 는 userId / search 필터를 where 절에 반영해야 한다.
 *
 * 생성자 의존성이 많아 Object.create 로 생성자 우회 후 메서드만 격리 테스트한다.
 */
describe('OrderFromService — IDOR / blacklist / admin 필터 (P0)', () => {
  const makeUser = (id: number, authority: IUserAuthority) => ({ id, authority }) as any;

  const makeSut = () => {
    const sut: any = Object.create(OrderFromService.prototype);
    sut.orderFromDefinitionRepository = {
      find: jest.fn().mockResolvedValue([]),
      existsBy: jest.fn().mockResolvedValue(false),
      insert: jest.fn().mockResolvedValue({ identifiers: [{ id: 100 }] }),
      update: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn().mockResolvedValue(null),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    sut.userRepository = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };
    // createPhone 은 이제 트랜잭션 내 manager.getRepository().insert() 로 저장한다.
    // 트랜잭션 매니저가 동일 repo 스파이를 반환하도록 연결해 INSERT 호출을 검증한다.
    const manager = { getRepository: jest.fn().mockReturnValue(sut.orderFromDefinitionRepository) };
    sut.dataSource = { transaction: jest.fn(async (cb: any) => cb(manager)) };
    sut.reconcileDefaultAndMirror = jest.fn().mockResolvedValue(undefined);
    return sut;
  };

  describe('getPhoneList — IDOR 가드', () => {
    it('CORPORATE_ADMIN 이 타 계정 userId 를 요청하면 403, 조회하지 않는다', async () => {
      const sut = makeSut();
      const user = makeUser(10, IUserAuthority.CORPORATE_ADMIN);

      await expect(sut.getPhoneList(user, { userId: 99 })).rejects.toThrow(ForbiddenException);
      expect(sut.orderFromDefinitionRepository.find).not.toHaveBeenCalled();
    });

    it('CORPORATE_ADMIN 도 본인 userId 면 통과한다', async () => {
      const sut = makeSut();
      const user = makeUser(10, IUserAuthority.CORPORATE_ADMIN);

      await sut.getPhoneList(user, { userId: 10 });
      expect(sut.orderFromDefinitionRepository.find).toHaveBeenCalled();
    });

    it('OPERATION_ADMIN 은 타 계정 userId 대리 조회가 허용된다', async () => {
      const sut = makeSut();
      const user = makeUser(1, IUserAuthority.OPERATION_ADMIN);

      await sut.getPhoneList(user, { userId: 99 });
      expect(sut.orderFromDefinitionRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ userId: 99 }) }),
      );
    });

    it('SUPER_ADMIN 은 타 계정 userId 대리 조회가 허용된다', async () => {
      const sut = makeSut();
      const user = makeUser(1, IUserAuthority.SUPER_ADMIN);

      await sut.getPhoneList(user, { userId: 99 });
      expect(sut.orderFromDefinitionRepository.find).toHaveBeenCalled();
    });

    // 빈 user query(`?userId=`)가 @Type(()=>Number) 로 0 으로 변환되어 들어오는 케이스.
    // `0 ?? user.id` 가 0 을 흘려 보내 본인 조회가 403/0건으로 깨지던 회귀를 잠근다.
    it('userId 가 0(빈 쿼리 변환값)이면 본인 조회로 떨어뜨린다 — CORPORATE_ADMIN 도 403 아님', async () => {
      const sut = makeSut();
      const user = makeUser(10, IUserAuthority.CORPORATE_ADMIN);

      await sut.getPhoneList(user, { userId: 0 });
      expect(sut.orderFromDefinitionRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ userId: 10 }) }),
      );
    });

    it('userId 미전달(undefined)이면 본인 조회한다', async () => {
      const sut = makeSut();
      const user = makeUser(10, IUserAuthority.CORPORATE_ADMIN);

      await sut.getPhoneList(user, {});
      expect(sut.orderFromDefinitionRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ userId: 10 }) }),
      );
    });
  });

  describe('createPhone — IDOR 가드 + 블랙리스트', () => {
    it('CORPORATE_ADMIN 이 타 계정 명의로 등록하면 403, INSERT 하지 않는다', async () => {
      const sut = makeSut();
      const user = makeUser(10, IUserAuthority.CORPORATE_ADMIN);

      await expect(sut.createPhone(user, { from: '01012345678', userId: 99 })).rejects.toThrow(ForbiddenException);
      expect(sut.orderFromDefinitionRepository.insert).not.toHaveBeenCalled();
    });

    it('블랙리스트 번호(1644-3614)는 정규화 후 차단한다', async () => {
      const sut = makeSut();
      const user = makeUser(10, IUserAuthority.CORPORATE_ADMIN);

      await expect(sut.createPhone(user, { from: '1644-3614' })).rejects.toThrow(BadRequestException);
      expect(sut.orderFromDefinitionRepository.insert).not.toHaveBeenCalled();
    });

    it('블랙리스트 번호(하이픈 없는 16443614)도 차단한다', async () => {
      const sut = makeSut();
      const user = makeUser(10, IUserAuthority.CORPORATE_ADMIN);

      await expect(sut.createPhone(user, { from: '16443614' })).rejects.toThrow(BadRequestException);
    });

    it('정상 번호는 INSERT 한다', async () => {
      const sut = makeSut();
      const user = makeUser(10, IUserAuthority.CORPORATE_ADMIN);

      await sut.createPhone(user, { from: '01099998888' });
      expect(sut.orderFromDefinitionRepository.insert).toHaveBeenCalledWith(
        expect.objectContaining({ from: '01099998888', userId: 10, requestStatus: OrderFromRequestStatus.PENDING }),
      );
    });
  });

  describe('setDefault — IDOR 가드', () => {
    it('CORPORATE_ADMIN 이 타 계정 기본번호를 설정하면 403, 조회/변경하지 않는다', async () => {
      const sut = makeSut();
      const user = makeUser(10, IUserAuthority.CORPORATE_ADMIN);

      await expect(sut.setDefault(user, { id: 5, userId: 99 })).rejects.toThrow(ForbiddenException);
      expect(sut.orderFromDefinitionRepository.findOne).not.toHaveBeenCalled();
      expect(sut.orderFromDefinitionRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('getAdminList — 동적 필터', () => {
    const whereOf = (sut: any) => sut.orderFromDefinitionRepository.findAndCount.mock.calls[0][0].where;

    it('userId 필터를 where 절에 반영한다', async () => {
      const sut = makeSut();
      await sut.getAdminList({ userId: 42 });
      expect(whereOf(sut).userId).toBe(42);
    });

    it('search 필터는 Like 연산자로 where 절에 반영한다', async () => {
      const sut = makeSut();
      await sut.getAdminList({ search: '1234' });
      expect(whereOf(sut).from).toBeInstanceOf(FindOperator);
    });

    it('필터 미전달 시 userId / from 조건이 없다 (전체 조회 하위호환)', async () => {
      const sut = makeSut();
      await sut.getAdminList({});
      const where = whereOf(sut);
      expect(where.userId).toBeUndefined();
      expect(where.from).toBeUndefined();
    });

    it('공백 search 는 무시한다', async () => {
      const sut = makeSut();
      await sut.getAdminList({ search: '   ' });
      expect(whereOf(sut).from).toBeUndefined();
    });
  });
});
