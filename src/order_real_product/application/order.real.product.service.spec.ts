jest.mock('typeorm-transactional', () => ({
  Transactional: () => () => undefined,
}));

const mockExcelAddRow = jest.fn();
const mockExcelWriteFile = jest.fn();

jest.mock('exceljs', () => ({
  Workbook: jest.fn().mockImplementation(() => ({
    addWorksheet: jest.fn().mockReturnValue({
      columns: [],
      addRow: mockExcelAddRow,
    }),
    xlsx: {
      writeFile: mockExcelWriteFile,
    },
  })),
}));

import { OrderRealProductService } from './order.real.product.service';
import { IUserAuthority } from '../../user/interface/user.authority';

const createQueryBuilder = (result: unknown, count = 1) => ({
  innerJoinAndSelect: jest.fn().mockReturnThis(),
  leftJoinAndSelect: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  andWhere: jest.fn().mockReturnThis(),
  take: jest.fn().mockReturnThis(),
  skip: jest.fn().mockReturnThis(),
  getOne: jest.fn().mockResolvedValue(result),
  getMany: jest.fn().mockResolvedValue(result),
  getManyAndCount: jest.fn().mockResolvedValue([result, count]),
});

const createService = () => {
  const orderRepository = {
    createQueryBuilder: jest.fn(),
    save: jest.fn(),
  };
  const orderProductMappingRepository = {
    find: jest.fn(),
    save: jest.fn(),
  };
  const activityLogService = {
    verifyPassword: jest.fn().mockResolvedValue(undefined),
    createLog: jest.fn().mockResolvedValue(undefined),
  };

  const service = new OrderRealProductService(
    orderRepository as any,
    orderProductMappingRepository as any,
    {} as any,
    {} as any,
    {} as any,
    activityLogService as any,
  );

  return { service, orderRepository, orderProductMappingRepository, activityLogService };
};

describe('OrderRealProductService 금액 산식', () => {
  it('실물상품 가격 수정 시 부가세 포함 총액에 수량을 반영한다', async () => {
    const { service, orderRepository, orderProductMappingRepository } = createService();
    const order = { id: 1, status: 'ORDER_PENDING' };
    const mapping = {
      id: 10,
      realProductOrderId: order.id,
      price: 10000,
      quantity: 3,
      totalPrice: 33000,
    };

    orderRepository.createQueryBuilder.mockReturnValue(createQueryBuilder(order));
    orderProductMappingRepository.find.mockResolvedValue([mapping]);

    await service.update(
      { id: 1, authority: IUserAuthority.SUPER_ADMIN } as any,
      {
        realProductOrderId: order.id,
        realProductOrderInfo: [{ mappingId: mapping.id, price: 12000 }],
      } as any,
    );

    expect(mapping.price).toBe(12000);
    expect(mapping.totalPrice).toBe(39600);
    expect(orderProductMappingRepository.save).toHaveBeenCalledWith([mapping]);
  });

  it('실물상품 정산 조회는 totalPrice를 부가세 포함 총액으로 보고 공급금액과 부가세를 분리한다', async () => {
    const { service, orderRepository } = createService();
    const order = {
      id: 1,
      eventName: '이벤트',
      businessUser: {
        personName: '담당자',
        company: { businessName: '고객사' },
      },
      user: { personName: '관리자' },
      orderRealProductMappings: [
        {
          quantity: 3,
          price: 12000,
          totalPrice: 39600,
          product: {
            price: 9000,
            name: '실물상품',
            classification: { classification: '분류' },
            brand: { nameKorean: '브랜드' },
          },
        },
      ],
    };

    orderRepository.createQueryBuilder.mockReturnValue(createQueryBuilder([order]));

    const result = await service.getSettlement(
      { id: 1, authority: IUserAuthority.SUPER_ADMIN } as any,
      { page: 1, take: 10 } as any,
    );

    expect(result.list).toHaveLength(1);
    expect(result.list[0]).toMatchObject({
      salePrice: 12000,
      saleTotalPrice: 36000,
      tax: 3600,
      totalAmount: 39600,
      profitAmount: 9000,
      profitPercent: 25,
    });
  });

  it('실물상품 정산 엑셀도 공급금액과 부가세를 분리하고 totalPrice를 합계금액으로 사용한다', async () => {
    mockExcelAddRow.mockClear();
    mockExcelWriteFile.mockClear();

    const { service, orderRepository } = createService();
    const order = {
      id: 1,
      eventName: '이벤트',
      businessUser: {
        personName: '담당자',
        company: { businessName: '고객사' },
      },
      user: { personName: '관리자' },
      orderRealProductMappings: [
        {
          quantity: 3,
          price: 12000,
          totalPrice: 39600,
          product: {
            price: 9000,
            name: '실물상품',
            classification: { classification: '분류' },
            brand: { nameKorean: '브랜드' },
          },
        },
      ],
    };

    orderRepository.createQueryBuilder.mockReturnValue(createQueryBuilder([order]));

    await service.settleExcelDownload(
      { id: 1, email: 'admin@example.com', authority: IUserAuthority.SUPER_ADMIN } as any,
      { password: 'pw', downloadReason: '검증' } as any,
    );

    expect(mockExcelAddRow).toHaveBeenCalledWith(
      expect.objectContaining({
        salePrice: 12000,
        saleTotalPrice: 36000,
        tax: 3600,
        totalAmount: 39600,
        profitAmount: 9000,
        profitPercent: 25,
      }),
    );
    expect(mockExcelWriteFile).toHaveBeenCalled();
  });
});
