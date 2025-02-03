import { mock } from 'jest-mock-extended';
import { Repository } from 'typeorm';
import { BrandEntity } from '../../entity/brand.entity';
import { createMockQueryBuilder } from '../../common/test/mock.query.builder';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { createMockRepositoryMethod } from '../../common/test/mock.repository.method';
import { BrandService } from './brand.service';
import { BrandCreateReqDto, BrandGetSearchListReqDto } from '../api/brand.req.dto';
import { BrandEntityTest } from '../../../test/infra/brand.entity.test';

describe('BrandService text', () => {
  let sut: BrandService;
  let brandRepository: any = mock<Repository<BrandEntity>>();
  let queryBuilder = createMockQueryBuilder();

  beforeEach(async () => {
    queryBuilder = createMockQueryBuilder();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BrandService,
        {
          provide: getRepositoryToken(BrandEntity),
          useValue: {
            ...brandRepository,
            ...createMockRepositoryMethod(),
            createQueryBuilder: jest.fn(() => queryBuilder),
          },
        },
      ],
    }).compile();

    sut = module.get<BrandService>(BrandService);
    brandRepository = module.get<Repository<BrandEntity>>(getRepositoryToken(BrandEntity));
  });

  describe('getSearchList 테스트', () => {
    it('성공적으로 조회한 경우', async () => {
      const givenGetQuery: BrandGetSearchListReqDto = {
        searchText: undefined,
        page: 1,
        take: 5,
      };

      queryBuilder.getManyAndCount.mockResolvedValue([
        [
          {
            ...BrandEntityTest(),
            id: 1,
            nameKorean: '테스트',
          },
        ],
        1,
      ]);

      const result = await sut.getSearchList(givenGetQuery);

      expect(result.list[0].id).toBe(1);
      expect(result.list[0].nameKorean).toBe('테스트');
    });
  });

  describe('create 신규 등록 테스트', () => {
    it('신규 등록에 성공한 경우', async () => {
      const givenGetBody: BrandCreateReqDto = {
        nameEnglish: 'test',
        nameKorean: '테스트',
        isUsed: true,
      };
      brandRepository.findOne.mockResolvedValue(null);

      await sut.create(givenGetBody);
      expect(brandRepository.insert).toHaveBeenCalledWith({
        code: 'EBR00001',
        nameEnglish: 'test',
        nameKorean: '테스트',
        isUsed: true,
      });
    });
  });
});
