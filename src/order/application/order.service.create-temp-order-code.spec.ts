import { OrderService } from './order.service';
import { IOrderType } from '../interface/order.type';
import { deriveOrderCodeFromId } from '../domain/order.code';
import {
  addTransactionalDataSource,
  deleteDataSourceByName,
  initializeTransactionalContext,
} from 'typeorm-transactional';

// D3-51: 내부 createTemp 는 insert() 기반 채번(외부 save() 기반과 메커니즘이 다름).
//   insert(임시코드) → identifiers[0].id → update(id, EPEVT코드)
// insert/update 직후 매핑 저장에서 sentinel 로 중단시켜 2-step 채번 계약만 검증한다(RDS 미접속, 전부 mock).

describe('createTemp 주문코드 id 파생 채번 (D3-51)', () => {
  beforeAll(() => {
    initializeTransactionalContext();
    deleteDataSourceByName('default');
    addTransactionalDataSource({
      name: 'default',
      patch: false,
      dataSource: {
        transaction: async (...args: any[]) => {
          const callback = typeof args[0] === 'function' ? args[0] : args[1];
          return callback({});
        },
      } as any,
    });
  });

  afterAll(() => {
    deleteDataSourceByName('default');
  });

  const ASSIGNED_ID = 4242;
  const STOP = new Error('__STOP_AFTER_2STEP__');

  const makeService = () => {
    const service = Object.create(OrderService.prototype) as any;
    service.assertNoForbiddenWord = jest.fn(async () => undefined);
    service.validateSendMethods = jest.fn(async () => undefined);
    service.productRepository = {
      find: jest.fn(async () => [{ id: 1, price: 1000, name: 'P', brand: null, expireDay: 30, imagePath: null }]),
    };
    service.userRepository = {
      findOneOrFail: jest.fn(async () => ({ id: 1, company: null })),
    };
    service.orderRepository = {
      insert: jest.fn(async () => ({ identifiers: [{ id: ASSIGNED_ID }] })),
      update: jest.fn(async () => undefined),
    };
    // insert/update 이후 첫 다운스트림 저장 — 여기서 멈춰 2-step 만 검증
    service.orderProductMappingRepository = {
      save: jest.fn(async () => {
        throw STOP;
      }),
    };
    service.cryptoCipher = { encryptDeliveryTarget: (v: string) => `enc(${v})` };
    return service;
  };

  const body = {
    type: IOrderType.GENERAL,
    eventName: 'event',
    orderProductList: [
      { productId: 1, amount: 1, sendType: 'IMMEDIATE', orderDeliveryList: [{ deliveryTarget: '01012345678' }] },
    ],
  };
  const user = { id: 1, email: 'owner@example.com', authority: 'USER' };

  it('임시코드(TMP-)로 insert 후 id 파생 코드로 update 한다(2-step)', async () => {
    const service = makeService();

    await expect(service.createTemp(user, body)).rejects.toBe(STOP);

    // 1) insert 는 임시코드로 1회
    expect(service.orderRepository.insert).toHaveBeenCalledTimes(1);
    const insertArg = service.orderRepository.insert.mock.calls[0][0];
    expect(insertArg.code.startsWith('TMP-')).toBe(true);
    expect(insertArg.code.startsWith('EPEVT')).toBe(false);

    // 2) update 는 (확정 id, EPEVT 파생 코드)로 1회
    expect(service.orderRepository.update).toHaveBeenCalledTimes(1);
    const [updateId, updatePayload] = service.orderRepository.update.mock.calls[0];
    expect(updateId).toBe(ASSIGNED_ID);
    expect(updatePayload).toEqual({ code: deriveOrderCodeFromId(ASSIGNED_ID) });
    expect(updatePayload.code).toBe('EPEVT00000004242');
  });

  it('채번을 위한 최신 code 조회(read-max)를 하지 않는다', async () => {
    const service = makeService();
    service.orderRepository.findOne = jest.fn(async () => null);

    await expect(service.createTemp(user, body)).rejects.toBe(STOP);

    // findOne(code DESC) 채번 조회가 제거되어야 함 (동시 채번 경쟁 구간 소멸)
    expect(service.orderRepository.findOne).not.toHaveBeenCalled();
  });

  // 드라이버/엣지 세 형태 모두 커버:
  //  - undefined (identifiers 누락): identifiers?.[0] 이 undefined
  //  - [] (빈 배열): identifiers[0] 이 undefined → 과거엔 .id 접근에서 raw TypeError 였음
  //  - [{}] (id 부재): identifiers[0].id 가 undefined
  // 이제 셋 다 ?.[0]?.id + 명시 가드로 "생성 id가 없" 도메인 에러가 되어 확정코드 UPDATE 전에 실패.
  // (정규식은 명시 가드 메시지만 고정 — 가드를 지우면 deriveOrderCodeFromId 로 흘러 다른 에러가 나므로 실패)
  it.each<[string, unknown]>([
    ['identifiers 누락', undefined],
    ['빈 배열', []],
    ['id 부재', [{}]],
  ])('insert 결과에 생성 id가 없으면(%s) 확정코드 UPDATE 전에 명확히 실패한다(부분주문 방지, F3)', async (_label, identifiers) => {
    const service = makeService();
    service.orderRepository.insert = jest.fn(async () => ({ identifiers })) as never;

    await expect(service.createTemp(user, body)).rejects.toThrow(/생성 id가 없/);
    // 확정코드 UPDATE 는 호출되지 않아야(잘못된 code 로 갱신 방지) → 트랜잭션 롤백으로 임시행도 소멸
    expect(service.orderRepository.update).not.toHaveBeenCalled();
  });
});
