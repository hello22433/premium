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
    create: jest.fn(),
    createQueryBuilder: jest.fn(),
    save: jest.fn(),
  };
  const orderProductMappingRepository = {
    find: jest.fn(),
    save: jest.fn(),
  };
  const productRepository = {
    find: jest.fn(),
  };
  const userRepository = {
    findOne: jest.fn(),
  };
  const activityLogService = {
    verifyPassword: jest.fn().mockResolvedValue(undefined),
    createLog: jest.fn().mockResolvedValue(undefined),
  };

  const service = new OrderRealProductService(
    orderRepository as any,
    orderProductMappingRepository as any,
    productRepository as any,
    userRepository as any,
    {} as any,
    activityLogService as any,
  );

  return { service, orderRepository, orderProductMappingRepository, productRepository, userRepository, activityLogService };
};

describe('OrderRealProductService 금액 산식', () => {
  it.each([0, -1])('실물상품 주문 생성 시 수량이 %s이면 저장하지 않고 실패한다', async (quantity) => {
    const { service, orderRepository, orderProductMappingRepository, productRepository, userRepository } = createService();

    userRepository.findOne.mockResolvedValue({ id: 100 });
    productRepository.find.mockResolvedValue([{ id: 200, price: 50000 }]);
    orderRepository.create.mockReturnValue({ id: 1 });

    await expect(
      service.order(
        { id: 1, authority: IUserAuthority.SUPER_ADMIN } as any,
        {
          userId: 100,
          eventName: '이벤트',
          publicChargeTaxPayment: 'PERSON',
          processMethod: 'PRE',
          isProcess: false,
          orderRealProductList: [{ productId: 200, quantity, price: 10000 }],
        } as any,
      ),
    ).rejects.toThrow('수량은 1개 이상이어야 합니다.');

    expect(orderProductMappingRepository.save).not.toHaveBeenCalled();
  });

  it.each([0, -10000])('실물상품 가격 수정 시 가격이 %s이면 저장하지 않고 실패한다', async (price) => {
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

    await expect(
      service.update(
        { id: 1, authority: IUserAuthority.SUPER_ADMIN } as any,
        {
          realProductOrderId: order.id,
          realProductOrderInfo: [{ mappingId: mapping.id, price }],
        } as any,
      ),
    ).rejects.toThrow('공급가액은 1원 이상이어야 합니다.');

    expect(orderProductMappingRepository.save).not.toHaveBeenCalled();
  });

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

  it('실물상품 정산 조회는 오염된 totalPrice를 신뢰하지 않고 합계금액을 재계산한다', async () => {
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
          quantity: 2,
          price: 10000,
          totalPrice: 11000,
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
      salePrice: 10000,
      saleTotalPrice: 20000,
      tax: 2000,
      totalAmount: 22000,
      profitAmount: 2000,
      profitPercent: 10,
    });
  });

  it('실물상품 정산 엑셀도 오염된 totalPrice를 신뢰하지 않고 합계금액을 재계산한다', async () => {
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
          quantity: 2,
          price: 10000,
          totalPrice: 11000,
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
        salePrice: 10000,
        saleTotalPrice: 20000,
        tax: 2000,
        totalAmount: 22000,
        profitAmount: 2000,
        profitPercent: 10,
      }),
    );
    expect(mockExcelWriteFile).toHaveBeenCalled();
  });
});
