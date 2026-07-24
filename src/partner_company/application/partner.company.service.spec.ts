import { mock } from 'jest-mock-extended';
import { Repository } from 'typeorm';
import { PartnerCompanyEntity } from '../../entity/partner.company.entity';
import { PartnerCompanyService } from './partner.company.service';
import {
  PartnerCompanyCreateReqDto,
  PartnerCompanyGetDetailReqParamDto,
  PartnerCompanyGetListReqQueryDto,
  PartnerCompanyGetSearchListReqQueryDto,
} from '../api/partner.company.req.dto';
import { PartnerCompanyEntityTest } from '../../../test/infra/partner.company.entity.test';
import { createMockQueryBuilder } from '../../common/test/mock.query.builder';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { createMockRepositoryMethod } from '../../common/test/mock.repository.method';
import { IPartnerCompanySettleCondition } from '../interface/partner.company.settle.condition';
import { IPartnerCompanySettleMethod } from '../interface/partner.company.settle.method';
import { BadRequestException } from '@nestjs/common';
import { CryptoCipher } from '../../common/infra/crypto.cipher';

const cipherStub = {
  encryptAccountNumber: (v: string) => v,
  safeDecryptAccountNumber: (v: string) => v,
  encryptDeliveryTarget: (v: string) => v,
  safeDecryptDeliveryTarget: (v: string) => v,
} as unknown as CryptoCipher;

describe('partner company service test', () => {
  let sut: PartnerCompanyService;
  let partnerCompanyRepository: any = mock<Repository<PartnerCompanyEntity>>();
  let queryBuilder = createMockQueryBuilder();

  beforeEach(async () => {
    queryBuilder = createMockQueryBuilder();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PartnerCompanyService,
        {
          provide: getRepositoryToken(PartnerCompanyEntity),
          useValue: {
            ...partnerCompanyRepository,
            ...createMockRepositoryMethod(),
            createQueryBuilder: jest.fn(() => queryBuilder),
          },
        },
        { provide: CryptoCipher, useValue: cipherStub },
      ],
    }).compile();

    sut = module.get<PartnerCompanyService>(PartnerCompanyService);
    partnerCompanyRepository = module.get<Repository<PartnerCompanyEntity>>(getRepositoryToken(PartnerCompanyEntity));
  });

  describe('getSearchList 협력사 조회 기능 테스트', () => {
    it('성공적으로 조회한 경우', async () => {
      const givenGetQuery: PartnerCompanyGetSearchListReqQueryDto = {
        businessName: undefined,
        page: 1,
        take: 5,
      };

      partnerCompanyRepository.find.mockResolvedValue([
        {
          ...PartnerCompanyEntityTest(),
          id: 1,
        },
      ]);
      partnerCompanyRepository.count.mockResolvedValue(1);

      const result = await sut.getSearchList(givenGetQuery);

      expect(result.list[0].id).toBe(1);
      expect(result.totalPage).toBe(1);
      expect(result.totalCount).toBe(1);
      expect(result.currentPage).toBe(1);
    });
  });

  describe('getList 협력사 관리 조회 기능 테스트', () => {
    it('성공적으로 조회한 경우', async () => {
      const givenGetQuery: PartnerCompanyGetListReqQueryDto = {
        startCreatedAt: undefined,
        endCreatedAt: undefined,
        settleCondition: undefined,
        page: 1,
        take: 10,
      };
      queryBuilder.getManyAndCount.mockResolvedValue([
        [
          {
            ...PartnerCompanyEntityTest(),
            id: 1,
          },
        ],
        1,
      ]);

      const result = await sut.getList(givenGetQuery);

      expect(result.list[0].id).toBe(1);
      expect(result.totalPage).toBe(1);
      expect(result.totalCount).toBe(1);
      expect(result.currentPage).toBe(1);
    });
  });

  describe('getDetail 협력사 자세히 보기 테스트', () => {
    it('조회에 성공한 경우', async () => {
      const giveGetParam: PartnerCompanyGetDetailReqParamDto = {
        id: 1,
      };

      partnerCompanyRepository.findOne.mockResolvedValue({
        ...PartnerCompanyEntityTest(),
        id: 1,
      });

      const result = await sut.getDetail(giveGetParam);
      expect(result.id).toBe(1);
    });

    it('협력사 데이터가 존재하지 않아 에러가 발생한 경우', async () => {
      const giveGetParam: PartnerCompanyGetDetailReqParamDto = {
        id: 1,
      };

      partnerCompanyRepository.findOne.mockResolvedValue(null);

      await expect(async () => await sut.getDetail(giveGetParam)).rejects.toThrow(
        new BadRequestException('협력사가 존재하지 않습니다.'),
      );
    });
  });

  describe('create 협력사 신규 등록 테스트', () => {
    it('성공적으로 생성한 경우', async () => {
      const givenGetBody: PartnerCompanyCreateReqDto = {
        corporateNumber: null,
        businessNumber: 'string',
        businessName: 'string',
        businessAddress: 'string',
        businessPhoneNumber: 'string',
        personName: 'string',
        personPhoneNumber: 'string',
        personEmail: 'string',
        settleCondition: IPartnerCompanySettleCondition['PRE_PAYMENT'],
        settleMethod: IPartnerCompanySettleMethod['CARD'],
        maximumLimit: 100_000,
        bankName: 'string',
        bankNumber: 'string',
        settleDay: 10,
        type: undefined,
      };

      partnerCompanyRepository.findOne.mockResolvedValue(null);
      await sut.create(givenGetBody);

      expect(partnerCompanyRepository.insert).toHaveBeenCalledWith({
        code: 'EMD0000001',
        corporateNumber: null,
        businessNumber: 'string',
        businessName: 'string',
        businessAddress: 'string',
        businessPhoneNumber: 'string',
        personName: 'string',
        personPhoneNumber: 'string',
        personEmail: 'string',
        settleCondition: IPartnerCompanySettleCondition['PRE_PAYMENT'],
        settleMethod: IPartnerCompanySettleMethod['CARD'],
        maximumLimit: 100_000,
        bankName: 'string',
        bankNumber: 'string',
        settleDay: 10,
        type: null,
      });
    });
  });
});
