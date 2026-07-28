import {
  addTransactionalDataSource,
  deleteDataSourceByName,
  initializeTransactionalContext,
} from 'typeorm-transactional';
import { ExternalApiService } from './external.api.service';
import { WalletCutoverMode } from '../../wallet/config/wallet-cutover.config';
import { deriveOrderCodeFromId } from '../../order/domain/order.code';

// D3-51: 주문코드 채번을 "최신 code 읽고 +1"(CreateCode)에서 order.id 파생 2-step 으로 전환.
// phaseA_createAndDeduct 를 실제 구동해 (1)임시코드 INSERT → (2)id 파생 UPDATE 흐름과
// read-max 조회 제거(동시 채번 경쟁 구간 소멸)를 검증한다.

// @Transactional() 데코레이터가 phaseA 를 감싸므로 storage driver + 더미 data source 필요.
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

const ctx = {
  apiApp: { id: '1', requireExternalCustomerId: false },
  apiCredential: { id: '1' },
  billingUserId: 42,
  externalCustomerId: null,
} as any;

function makeAccount() {
  return { user: { id: 42, companyId: null, settleMethod: 'CASH', company: undefined } } as any;
}

// phaseA 를 실제 구동하는 최소 하네스. save 는 id 를 채번(auto_increment 모사)하고,
// findOne 은 호출되면 안 되지만(read-max 제거) 안전하게 stub.
function makeHarness(assignedId = 777) {
  const svc = Object.create(ExternalApiService.prototype) as ExternalApiService;
  // §9 컷오버 게이트 — 단위 테스트 기본값은 '미전환 건'(legacy 경로 그대로 통과).
  (svc as any).cutoverGuard = {
    assertLegacyAllowed: jest.fn().mockResolvedValue(undefined),
    assertRefundExecutionAllowed: jest.fn().mockResolvedValue(undefined),
    isCutover: jest.fn().mockResolvedValue(false),
    splitLegacyAllowed: jest.fn(async (ids: number[]) => ({ allowed: ids, blocked: [] })),
  };
  (svc as any).logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };

  const savedCodes: string[] = [];
  const savedRows: Array<{ id: number; code: string }> = [];
  const orderFindOne = jest.fn(async () => null);
  const orderSave = jest.fn(async (e: any) => {
    if (e.id == null) e.id = assignedId; // DB auto_increment 모사: INSERT 시 id 부여(이후 save는 같은 id 유지=UPDATE)
    savedCodes.push(e.code); // 호출 시점 code 스냅샷(문자열 불변)
    savedRows.push({ id: e.id, code: e.code }); // 행 정체성(id) 추적 — 2번째 save가 같은 행인지 검증용
    return e;
  });
  (svc as any).orderRepository = {
    create: (v: any) => ({ ...v }),
    save: orderSave,
    findOne: orderFindOne,
  };
  (svc as any).orderProductMappingRepository = {
    create: (v: any) => ({ ...v }),
    save: jest.fn(async (e: any) => e),
  };
  (svc as any).orderDeliveryRepository = {
    create: (v: any) => ({ ...v }),
    save: jest.fn(async (e: any) => e),
    update: jest.fn(async () => undefined),
  };
  (svc as any).productRepository = {
    findOne: jest.fn(async () => ({
      id: 100,
      price: 30000,
      category: 'CAT',
      partnerCompany: { code: 'PC' },
      brand: { nameKorean: 'B' },
      expireDay: 30,
    })),
  };
  (svc as any).cryptoCipher = { encryptDeliveryTarget: (v: string) => `enc(${v})` };
  (svc as any).computeSettlementForBilling = jest.fn(async () => ({
    fee: null,
    priceAdjustment: null,
    settleAmount: 30000,
    cardSurchargeApplied: false,
  }));
  (svc as any).getAssignedProductIdsForBilling = jest.fn(async () => [100]);
  (svc as any).saveTransactionIds = jest.fn(async () => 'ulid-1');
  (svc as any).mappingResolver = {
    resolveBillingTarget: jest.fn(async () => ({
      billingUser: makeAccount().user,
      clientUserId: null,
      externalCustomerId: null,
    })),
  };
  (svc as any).walletCutoverConfig = { pr2DeliveryLifecycleMode: WalletCutoverMode.LEGACY };
  (svc as any).deductBalance = jest.fn(async () => undefined);

  // createSsgOrder 경로 전용 협력자(createOrder 테스트에는 무영향)
  (svc as any).productService = {
    findOrCreateSsgProductByPrice: jest.fn(async () => ({
      id: 100,
      price: 30000,
      name: 'SSG',
      brand: null,
      expireDay: 30,
      imagePath: null,
    })),
  };
  (svc as any).ssgEventService = { selectEventForOrder: jest.fn(async () => ({ id: 9 })) };

  return { svc, orderFindOne, orderSave, savedCodes, savedRows };
}

// insert/update(2-step) 직후 다운스트림 저장에서 멈추기 위한 sentinel
const STOP = new Error('__STOP_AFTER_2STEP__');

const dto = {
  productCode: 'P1',
  deliveryMethod: 'MMS',
  recipientPhone: '01000000000',
  message: '',
  title: 't',
  senderPhone: '0100',
} as any;

describe('createOrder 주문코드 id 파생 채번 (D3-51)', () => {
  it('확정 code 는 order.id 파생값(EPEVT+11자리)이다', async () => {
    const { svc } = makeHarness(777);
    const result = await (svc as any).phaseA_createAndDeduct(makeAccount(), dto, ctx);

    expect(result.order.code).toBe(deriveOrderCodeFromId(result.order.id));
    expect(result.order.code).toBe('EPEVT00000000777');
    expect(result.order.code).toMatch(/^EPEVT\d{11}$/);
  });

  it('먼저 임시코드(TMP-)로 INSERT 후 확정코드로 UPDATE 한다(2-step)', async () => {
    const { svc, savedCodes } = makeHarness(777);
    await (svc as any).phaseA_createAndDeduct(makeAccount(), dto, ctx);

    // 첫 저장(INSERT)은 임시코드, 마지막 저장(UPDATE)은 확정 EPEVT 코드
    expect(savedCodes.length).toBeGreaterThanOrEqual(2);
    expect(savedCodes[0].startsWith('TMP-')).toBe(true);
    expect(savedCodes[0].startsWith('EPEVT')).toBe(false);
    expect(savedCodes[savedCodes.length - 1]).toBe('EPEVT00000000777');
  });

  it('최신 code 조회(read-max)를 하지 않는다 — 동시 채번 경쟁 구간 소멸', async () => {
    const h = makeHarness(777);
    await (h.svc as any).phaseA_createAndDeduct(makeAccount(), dto, ctx);

    // 채번을 위해 orderRepository.findOne(code DESC)를 호출하던 로직이 제거되어야 함
    expect(h.orderFindOne).not.toHaveBeenCalled();
  });

  it('2번째 save 는 방금 insert된 같은 행(id)을 UPDATE 한다 — 새 행/딴 행 아님(F5)', async () => {
    const h = makeHarness(777);
    await (h.svc as any).phaseA_createAndDeduct(makeAccount(), dto, ctx);

    expect(h.savedRows.length).toBeGreaterThanOrEqual(2);
    const first = h.savedRows[0];
    const last = h.savedRows[h.savedRows.length - 1];
    expect(first.id).toBe(last.id); // 동일 행(정체성 보존) → 딴 행/새 행 쓰기면 실패
    expect(first.code.startsWith('TMP-')).toBe(true); // 첫 저장 = 임시코드
    expect(last.code).toBe('EPEVT00000000777'); // 마지막 저장 = 같은 행의 확정코드
  });
});

describe('createSsgOrder 주문코드 id 파생 채번 (D3-51)', () => {
  const ssgDto = {
    amount: 30000,
    deliveryMethod: 'ALIM_TALK',
    recipientPhone: '01000000000',
    message: '',
    title: 't',
    senderPhone: '0100',
    externalCustomerId: null,
  } as any;

  it('createOrder 와 동일하게 임시코드 → id 파생 코드 2-step 으로 채번한다', async () => {
    const h = makeHarness(888);
    // 2-step 직후 매핑 저장에서 중단 → 채번 계약만 검증
    (h.svc as any).orderProductMappingRepository.save = jest.fn(async () => {
      throw STOP;
    });

    await expect((h.svc as any).phaseA_createSsgAndDeduct(makeAccount(), ssgDto, ctx)).rejects.toBe(STOP);

    expect(h.savedCodes.length).toBeGreaterThanOrEqual(2);
    expect(h.savedCodes[0].startsWith('TMP-')).toBe(true);
    expect(h.savedCodes[h.savedCodes.length - 1]).toBe(deriveOrderCodeFromId(888));
    expect(h.savedCodes[h.savedCodes.length - 1]).toBe('EPEVT00000000888');
    expect(h.orderFindOne).not.toHaveBeenCalled();
  });
});
