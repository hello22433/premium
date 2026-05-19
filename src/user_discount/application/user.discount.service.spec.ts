import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UserDiscountService } from './user.discount.service';
import { UserDiscountEntity } from '../../entity/user.discount.entity';
import { UserEntity } from '../../entity/user.entity';
import { ClassificationEntity } from '../../entity/classification.entity';
import { createMockRepositoryMethod } from '../../common/test/mock.repository.method';
import { IUserAuthority } from '../../user/interface/user.authority';
import { UserDiscountCreateReqDto } from '../api/user.discount.req.dto';
import { IUserDiscountMethod } from '../interface/user.discount.method';
import { IUserDiscountCategory } from '../interface/user.discount.category';
import { IPriceAdjustment } from '../interface/price.adjustment';

describe('UserDiscountService', () => {
  let sut: UserDiscountService;
  let userRepository: any;

  const CORPORATE_ADMIN_USER = { id: 5, email: 'corp@test.com', authority: IUserAuthority.CORPORATE_ADMIN };
  const OPERATION_ADMIN_USER = { id: 10, email: 'op@test.com', authority: IUserAuthority.OPERATION_ADMIN };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserDiscountService,
        { provide: getRepositoryToken(UserDiscountEntity), useValue: createMockRepositoryMethod() },
        { provide: getRepositoryToken(UserEntity), useValue: createMockRepositoryMethod() },
        { provide: getRepositoryToken(ClassificationEntity), useValue: createMockRepositoryMethod() },
      ],
    }).compile();

    sut = module.get<UserDiscountService>(UserDiscountService);
    userRepository = module.get(getRepositoryToken(UserEntity));
  });

  describe('create 권한 검증', () => {
    const validBody = {
      userId: 1,
      method: IUserDiscountMethod.BULK,
      category: IUserDiscountCategory.PRODUCT_GROUP,
      group: '전체',
      priceAdjustment: IPriceAdjustment.DISCOUNT,
      pricePercent: 10,
    };

    it('CORPORATE_ADMIN: ForbiddenException', async () => {
      await expect(sut.create(CORPORATE_ADMIN_USER as any, validBody as any)).rejects.toThrow(ForbiddenException);
    });

    it('OPERATION_ADMIN: 권한 통과 후 유저 조회 진행', async () => {
      userRepository.findOneBy.mockResolvedValue(null);

      await expect(sut.create(OPERATION_ADMIN_USER as any, validBody as any)).rejects.toThrow(
        new BadRequestException('User does not exist'),
      );
    });
  });

  describe('create pricePercent 범위 검증', () => {
    const baseBody = {
      userId: 1,
      method: IUserDiscountMethod.BULK,
      category: IUserDiscountCategory.PRODUCT_GROUP,
      group: '전체',
      priceAdjustment: IPriceAdjustment.DISCOUNT,
    };

    it('음수 입력 시 BadRequestException', async () => {
      await expect(sut.create(OPERATION_ADMIN_USER as any, { ...baseBody, pricePercent: -1 } as any)).rejects.toThrow(
        new BadRequestException('할인율은 0~100 사이여야 합니다.'),
      );
    });

    it('100 초과 입력 시 BadRequestException', async () => {
      await expect(sut.create(OPERATION_ADMIN_USER as any, { ...baseBody, pricePercent: 101 } as any)).rejects.toThrow(
        new BadRequestException('할인율은 0~100 사이여야 합니다.'),
      );
    });
  });

  describe('delete 권한 검증', () => {
    it('CORPORATE_ADMIN: ForbiddenException', async () => {
      await expect(sut.delete(CORPORATE_ADMIN_USER as any, { id: 1 })).rejects.toThrow(ForbiddenException);
    });
  });
});

describe('UserDiscountCreateReqDto pricePercent 검증', () => {
  const baseDto = {
    userId: 1,
    method: IUserDiscountMethod.BULK,
    category: IUserDiscountCategory.PRODUCT_GROUP,
    group: '전체',
    priceAdjustment: IPriceAdjustment.DISCOUNT,
  };

  it('음수 입력 시 유효성 검사 오류', async () => {
    const dto = plainToInstance(UserDiscountCreateReqDto, { ...baseDto, pricePercent: -1 });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'pricePercent')).toBe(true);
  });

  it('100 초과 입력 시 유효성 검사 오류', async () => {
    const dto = plainToInstance(UserDiscountCreateReqDto, { ...baseDto, pricePercent: 101 });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'pricePercent')).toBe(true);
  });

  it('0 입력 시 통과', async () => {
    const dto = plainToInstance(UserDiscountCreateReqDto, { ...baseDto, pricePercent: 0 });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'pricePercent')).toBe(false);
  });

  it('100 입력 시 통과', async () => {
    const dto = plainToInstance(UserDiscountCreateReqDto, { ...baseDto, pricePercent: 100 });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'pricePercent')).toBe(false);
  });
});
