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
import { CryptoCipher } from '../../common/infra/crypto.cipher';

const cipherStub = {
  encryptAccountNumber: (v: string) => v,
  safeDecryptAccountNumber: (v: string) => v,
  encryptDeliveryTarget: (v: string) => v,
  safeDecryptDeliveryTarget: (v: string) => v,
} as unknown as CryptoCipher;

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
    findOne: jest.fn(),
    save: jest.fn(),
  };
  const orderProductMappingRepository = {
    createQueryBuilder: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
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
    cipherStub,
  );

  return {
    service,
    orderRepository,
    orderProductMappingRepository,
    productRepository,
    userRepository,
    activityLogService,
  };
};

describe('OrderRealProductService 금액 산식', () => {
  it.each([0, -1])('실물상품 주문 생성 시 수량이 %s이면 저장하지 않고 실패한다', async (quantity) => {
    const { service, orderRepository, orderProductMappingRepository, productRepository, userRepository } =
      createService();

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
    expect(orderRepository.save).not.toHaveBeenCalled();
  });

  it.each([0, -10000])('실물상품 주문 생성 시 공급가액이 %s이면 저장하지 않고 실패한다', async (price) => {
    const { service, orderRepository, orderProductMappingRepository, productRepository, userRepository } =
      createService();

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
          orderRealProductList: [{ productId: 200, quantity: 1, price }],
        } as any,
      ),
    ).rejects.toThrow('공급가액을 입력해주세요.');

    expect(orderProductMappingRepository.save).not.toHaveBeenCalled();
    expect(orderRepository.save).not.toHaveBeenCalled();
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

describe('OrderRealProductService 실물상품 조회 접근 제어', () => {
  it('배송 추적 상태 조회는 고객사 계정일 때 본인 고객사 주문으로 제한한다', async () => {
    const { service, orderRepository } = createService();
    const queryBuilder = createQueryBuilder({
      id: 10,
      createdAt: new Date('2026-06-19T00:00:00.000Z'),
      eventName: '이벤트',
      businessUser: { personName: '담당자', company: { businessName: '고객사', businessAddress: '주소' } },
      orderRealProductMappings: [{ trackingNumber: null, product: { name: '상품' } }],
    });
    orderRepository.createQueryBuilder.mockReturnValue(queryBuilder);

    await (service as any).getDeliveryTrackingStatus(
      { id: 100, authority: IUserAuthority.CORPORATE_ADMIN },
      { id: 10 },
    );

    expect(queryBuilder.andWhere).toHaveBeenCalledWith('order.businessUserId = :userId', { userId: 100 });
  });

  it('배송완료 리포트 조회는 고객사 계정일 때 본인 고객사 주문으로 제한한다', async () => {
    const { service, orderRepository } = createService();
    const queryBuilder = createQueryBuilder({
      id: 10,
      status: 'ORDER_COMPLETED',
      createdAt: new Date('2026-06-19T00:00:00.000Z'),
      eventName: '이벤트',
      businessUser: {
        id: 100,
        personName: '담당자',
        personPhoneNumber: '010',
        email: 'user@example.com',
        company: { businessName: '고객사' },
      },
      orderRealProductMappings: [],
    });
    orderRepository.createQueryBuilder.mockReturnValue(queryBuilder);

    await (service as any).getDeliveryCompleteReport(
      { id: 100, authority: IUserAuthority.CORPORATE_ADMIN },
      { id: 10 },
    );

    expect(queryBuilder.andWhere).toHaveBeenCalledWith('order.businessUserId = :userId', { userId: 100 });
  });

  it('발주 상품 상세 조회는 고객사 계정일 때 본인 고객사 주문 매핑으로 제한한다', async () => {
    const { service, orderProductMappingRepository } = createService();
    const queryBuilder = createQueryBuilder({
      id: 20,
      realProductOrder: {
        id: 10,
        businessUserId: 100,
        businessUser: { bankName: '은행', bankNumber: '123', company: { businessName: '고객사' } },
        eventName: '이벤트',
      },
    });
    orderProductMappingRepository.createQueryBuilder.mockReturnValue(queryBuilder);

    await (service as any).getOrderProductMappingDetail(
      { id: 100, authority: IUserAuthority.CORPORATE_ADMIN },
      { id: 20 },
    );

    expect(queryBuilder.andWhere).toHaveBeenCalledWith('realProductOrder.businessUserId = :userId', { userId: 100 });
  });

  it('배송 추적 상세 조회는 고객사 계정일 때 본인 고객사 주문 매핑으로 제한한다', async () => {
    const { service, orderProductMappingRepository } = createService();
    const queryBuilder = createQueryBuilder(null);
    orderProductMappingRepository.createQueryBuilder.mockReturnValue(queryBuilder);

    await expect(
      (service as any).getDeliveryTrackingDetail({ id: 100, authority: IUserAuthority.CORPORATE_ADMIN }, { id: 20 }),
    ).rejects.toThrow('주문 매핑 정보를 찾을 수 없습니다.');

    expect(queryBuilder.andWhere).toHaveBeenCalledWith('realProductOrder.businessUserId = :userId', { userId: 100 });
  });

  it('관리자 계정은 실물상품 주문 조회 시 고객사 제한 조건을 추가하지 않는다', async () => {
    const { service, orderRepository } = createService();
    const queryBuilder = createQueryBuilder({
      id: 10,
      createdAt: new Date('2026-06-19T00:00:00.000Z'),
      eventName: '이벤트',
      businessUser: { personName: '담당자', company: { businessName: '고객사', businessAddress: '주소' } },
      orderRealProductMappings: [{ trackingNumber: null, product: { name: '상품' } }],
    });
    orderRepository.createQueryBuilder.mockReturnValue(queryBuilder);

    await (service as any).getDeliveryTrackingStatus({ id: 1, authority: IUserAuthority.OPERATION_ADMIN }, { id: 10 });

    expect(queryBuilder.andWhere).not.toHaveBeenCalledWith('order.businessUserId = :userId', expect.anything());
  });
});
