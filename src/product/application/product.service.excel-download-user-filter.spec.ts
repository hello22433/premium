jest.mock('typeorm-transactional', () => ({
  IsolationLevel: { READ_COMMITTED: 'READ COMMITTED' },
  Transactional: () => () => undefined,
}));

jest.mock('exceljs', () => {
  return {
    Workbook: jest.fn().mockImplementation(() => ({
      addWorksheet: jest.fn(() => ({
        columns: [],
        addRow: jest.fn(),
      })),
      xlsx: {
        writeFile: jest.fn(async () => undefined),
      },
    })),
  };
});

jest.mock('../../util/file.util', () => ({
  createExportTempPath: jest.fn(() => 'test.xlsx'),
}));

import { ProductService } from './product.service';
import { IProductUseStatus } from '../interface/product.status';

describe('ProductService.excelDownload - 고객사 연동상품 필터', () => {
  const createService = (eventMappings: { productId: number }[]) => {
    const qb: any = {
      innerJoinAndSelect: jest.fn(() => qb),
      leftJoinAndSelect: jest.fn(() => qb),
      andWhere: jest.fn(() => qb),
      getMany: jest.fn(async () => []),
    };

    const productRepository = {
      createQueryBuilder: jest.fn(() => qb),
    };
    const userRepository = {
      findOne: jest.fn(async () => ({ id: 10 })),
    };
    const userSyncProductEventRepository = {
      findOne: jest.fn(async () => ({
        id: 20,
        userSyncProductEventMappings: eventMappings,
      })),
    };
    const activityLogService = {
      verifyPassword: jest.fn(async () => undefined),
      createLog: jest.fn(async () => undefined),
    };

    const service = new ProductService(
      productRepository as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      userSyncProductEventRepository as any,
      {} as any,
      {} as any,
      {} as any,
      userRepository as any,
      {} as any,
      {} as any,
      activityLogService as any,
      {} as any,
    );

    return { service, qb };
  };

  const operator = { id: 1, email: 'admin@example.com' } as any;
  const request = {
    userId: 10,
    password: 'pw',
    downloadReason: '테스트',
  } as any;

  it('연동 이벤트는 있지만 매핑 상품이 없으면 전체 상품으로 풀리지 않도록 빈 결과 조건을 건다', async () => {
    const { service, qb } = createService([]);

    await service.excelDownload(operator, request);

    expect(qb.andWhere).toHaveBeenCalledWith('1 = 0');
    expect(qb.andWhere).not.toHaveBeenCalledWith('product.id IN (:...mappedProductIds)', expect.anything());
  });

  it('매핑 상품이 있으면 USE 상품만 엑셀 대상에 포함한다', async () => {
    const { service, qb } = createService([{ productId: 100 }]);

    await service.excelDownload(operator, request);

    expect(qb.andWhere).toHaveBeenCalledWith('product.id IN (:...mappedProductIds)', { mappedProductIds: [100] });
    expect(qb.andWhere).toHaveBeenCalledWith('product.useStatus = :excelMappedUseStatus', {
      excelMappedUseStatus: IProductUseStatus.USE,
    });
  });
});
