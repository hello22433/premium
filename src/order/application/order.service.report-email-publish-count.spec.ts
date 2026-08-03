import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { OrderService } from './order.service';
import { IReportSource } from '../interface/report.source';

/**
 * 이메일 전송 경로의 발행 카운트 반영 (sendReportEmail).
 *
 * 배경: 발송완료리포트/거래명세서를 이메일로 보내도 order.*ReportCount 가 0 으로 남아,
 * 정산 목록 발행 상태가 '-' 로 표시되고 isPublished=false(미발행) 필터에도 계속 잡혔다.
 * 카운트를 올리는 경로가 단건 PDF(POST .../report/pdf) 하나뿐이었던 것이 원인.
 *
 * 여기서 고정하는 계약:
 *  1) 발송완료리포트/거래명세서 이메일 성공 → 각자의 카운트 +1, source='EMAIL'
 *  2) 파기증명서 이메일 → 대응 카운트 컬럼이 없으므로 카운터를 건드리지 않는다
 *  3) 메일 발송 실패 → 카운터 미반영 (실패를 '발행 완료'로 표시하지 않는다)
 *  4) 메일 발송 실패여도 activity_log 는 남는다 (비가역 행위 기록 우선)
 *  5) 카운터 갱신은 save() 가 아니라 원자 UPDATE 한 문장 (order 전 컬럼 되쓰기 금지,
 *     count/source 부분 갱신으로 인한 '다운로드 완료' 오표시 방지)
 */

const BASE_USER = { id: 7, email: 'development@enmad.com' } as any;
const IP = '127.0.0.1';

const makeEmailBody = (orderId = 6142) =>
  ({
    orderId,
    to: 'yjh@example.com',
    subject: '발송완료리포트',
    content: '<p>리포트</p>',
    pdfBase64: Buffer.from('pdf').toString('base64'),
    pdfFileName: 'report.pdf',
  }) as any;

/**
 * 파기증명서 이메일 경로용 주문 fixture.
 *
 * 발행 게이트(resolveDestructionCertificateGate)를 통과해야 카운터 판정까지 도달한다.
 * 통과 조건이 두 축이라 둘 다 채운다:
 *  1) 발송건이 전부 파기됨 — deliveryTarget === '-'
 *  2) **파기 일자를 답할 수 있음** — destroyedAt 이 있어야 한다. 없으면 게이트가
 *     DESTROY_TIME_UNKNOWN 으로 400 을 던져 이 spec 의 관심사(카운터 미갱신)에 닿지 못한다.
 *
 * ⚠️ describe 마다 복사하지 말 것. 종전에 두 벌로 흩어져 있다가 게이트에 파기일 축이
 *    추가됐을 때 두 벌 모두 낡아 3건이 동시에 깨졌다. fixture 는 여기 한 곳에만 둔다.
 */
const makeDestructionOrder = () => ({
  id: 6142,
  status: 'DELIVERY_COMPLETE',
  orderProductMappings: [
    {
      id: 1,
      orderDeliveries: [
        {
          deliveryTarget: '-',
          deletedAt: null,
          status: 'COMPLETE',
          destroyedAt: new Date('2026-03-01T00:00:00Z'),
          destroyedAtSource: 'BATCH',
        },
      ],
    },
  ],
});

type SetupOptions = {
  sendSuccess?: boolean;
  order?: unknown;
  counterUpdateFails?: boolean;
  /** 엔티티 프로퍼티 리네임 등으로 컬럼명 해석이 실패하는 상황 */
  unknownColumn?: boolean;
  /** 메일은 나갔는데 activity_log INSERT 가 실패하는 상황 */
  createLogFails?: boolean;
};

const setupService = ({
  sendSuccess = true,
  order = { id: 6142 },
  counterUpdateFails = false,
  unknownColumn = false,
  createLogFails = false,
}: SetupOptions = {}) => {
  const service = Object.create(OrderService.prototype) as any;
  const callOrder: string[] = [];
  const loggedErrors: string[] = [];
  service.logger = {
    error: jest.fn((message: string) => {
      loggedErrors.push(message);
    }),
    warn: jest.fn(),
    log: jest.fn(),
  };

  // 원자 UPDATE 한 문장을 재현하는 최소 QueryBuilder 스텁.
  // set() 에 넘어간 페이로드와 where 조건을 그대로 붙잡아 단언에 쓴다.
  const updateCalls: { set: Record<string, unknown>; where: [string, unknown] }[] = [];
  const makeUpdateQb = () => {
    const captured: any = {};
    const qb: any = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn((payload: Record<string, unknown>) => {
        captured.set = payload;
        return qb;
      }),
      where: jest.fn((condition: string, params: unknown) => {
        captured.where = [condition, params];
        return qb;
      }),
      execute: jest.fn(async () => {
        callOrder.push('update');
        updateCalls.push(captured);
        if (counterUpdateFails) {
          throw new Error('Deadlock found when trying to get lock');
        }
        return { affected: 1 };
      }),
    };
    return qb;
  };

  service.orderRepository = {
    findOne: jest.fn().mockResolvedValue(order),
    createQueryBuilder: jest.fn(() => makeUpdateQb()),
    metadata: {
      // 실제 SnakeNamingStrategy 와 같은 형태를 흉내낸다. unknownColumn 이면 TypeORM 이
      // 미등록 프로퍼티에 대해 하는 것과 동일하게 undefined 를 돌려준다.
      findColumnWithPropertyName: jest.fn((prop: string) =>
        unknownColumn ? undefined : { databaseName: prop.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`) },
      ),
    },
    increment: jest.fn(),
    update: jest.fn(),
    save: jest.fn().mockResolvedValue(undefined),
  };
  service.updateCalls = updateCalls;
  service.mailSendSmtp = {
    send: jest
      .fn()
      .mockResolvedValue(
        sendSuccess
          ? { success: true, messageId: 'mid-1', error: null }
          : { success: false, messageId: null, error: 'SMTP 연결 실패' },
      ),
  };
  service.activityLogService = {
    createLog: jest.fn().mockImplementation(async () => {
      callOrder.push('createLog');
      if (createLogFails) {
        throw new Error('Deadlock found when trying to get lock');
      }
    }),
  };

  return { service, callOrder, loggedErrors };
};

describe('sendDeliveryCompleteReportEmail — 발송완료리포트 이메일 발행 카운트', () => {
  it('메일 발송에 성공하면 deliveryCompleteReportCount 를 1 증가시킨다', async () => {
    const { service } = setupService();

    const result = await service.sendDeliveryCompleteReportEmail(makeEmailBody(), BASE_USER, IP);

    expect(result.success).toBe(true);
    expect(service.updateCalls).toHaveLength(1);
    // 증가는 DB 측 `col + 1` 표현식이어야 한다 — 읽어온 값 +1 을 되쓰면 동시 요청에서 유실된다.
    const increment = service.updateCalls[0].set.deliveryCompleteReportCount;
    expect(typeof increment).toBe('function');
    expect(increment()).toBe('`delivery_complete_report_count` + 1');
  });

  it('발행 소스를 EMAIL 로 기록한다 (deliveryReportLastSource)', async () => {
    const { service } = setupService();

    await service.sendDeliveryCompleteReportEmail(makeEmailBody(), BASE_USER, IP);

    expect(service.updateCalls[0].set.deliveryReportLastSource).toBe(IReportSource.EMAIL);
    expect(service.updateCalls[0].where).toEqual(['id = :id', { id: 6142 }]);
  });

  it('count 와 source 를 한 문장으로 갱신한다 (중간 실패 시 source=NULL 오표시 방지)', async () => {
    const { service } = setupService();

    await service.sendDeliveryCompleteReportEmail(makeEmailBody(), BASE_USER, IP);

    // UPDATE 는 정확히 1회, 그 한 문장이 두 컬럼을 모두 담아야 한다.
    expect(service.updateCalls).toHaveLength(1);
    expect(Object.keys(service.updateCalls[0].set).sort()).toEqual([
      'deliveryCompleteReportCount',
      'deliveryReportLastSource',
    ]);
  });

  it('order 전 컬럼을 되쓰는 save() 를 쓰지 않는다 (동시 갱신 clobber 방지)', async () => {
    const { service } = setupService();

    await service.sendDeliveryCompleteReportEmail(makeEmailBody(), BASE_USER, IP);

    expect(service.orderRepository.save).not.toHaveBeenCalled();
  });

  it('카운터 갱신은 activity_log 기록 이후에 일어난다 (발송 기록 보존 우선)', async () => {
    const { service, callOrder } = setupService();

    await service.sendDeliveryCompleteReportEmail(makeEmailBody(), BASE_USER, IP);

    expect(callOrder).toEqual(['createLog', 'update']);
  });
});

describe('sendTransactionStatementReportEmail — 거래명세서 이메일 발행 카운트', () => {
  it('메일 발송에 성공하면 orderCompleteReportCount 를 1 증가시킨다', async () => {
    const { service } = setupService();

    const result = await service.sendTransactionStatementReportEmail(makeEmailBody(), BASE_USER, IP);

    expect(result.success).toBe(true);
    expect(service.updateCalls[0].set.orderCompleteReportCount()).toBe('`order_complete_report_count` + 1');
  });

  it('발행 소스를 EMAIL 로 기록한다 (transactionStatementLastSource)', async () => {
    const { service } = setupService();

    await service.sendTransactionStatementReportEmail(makeEmailBody(), BASE_USER, IP);

    expect(service.updateCalls[0].set.transactionStatementLastSource).toBe(IReportSource.EMAIL);
  });

  it('발송완료리포트 컬럼을 건드리지 않는다 (리포트 종류 간 교차 오염 없음)', async () => {
    const { service } = setupService();

    await service.sendTransactionStatementReportEmail(makeEmailBody(), BASE_USER, IP);

    // 짝이 어긋나면(예: orderCompleteReportCount + deliveryReportLastSource) 여기서 잡힌다.
    expect(Object.keys(service.updateCalls[0].set).sort()).toEqual([
      'orderCompleteReportCount',
      'transactionStatementLastSource',
    ]);
  });
});

describe('메일은 나갔는데 activity_log 기록이 실패하면', () => {
  // 발송(비가역) 이후의 DB 쓰기는 전부 best-effort 여야 한다. 여기서 예외가 밖으로 나가면
  // 500 → 운영자 재시도 → 고객사 중복 수신이 된다. 카운터 갱신에 적용한 판단과 동일하다.
  it('예외를 밖으로 내지 않고 성공으로 응답한다 (중복 발송 방지)', async () => {
    const { service } = setupService({ createLogFails: true });

    const result = await service.sendDeliveryCompleteReportEmail(makeEmailBody(), BASE_USER, IP);

    expect(result.success).toBe(true);
  });

  it('카운터 갱신은 그대로 진행한다 (정산 목록은 발행으로 뒤집힌다)', async () => {
    const { service } = setupService({ createLogFails: true });

    await service.sendDeliveryCompleteReportEmail(makeEmailBody(), BASE_USER, IP);

    expect(service.updateCalls).toHaveLength(1);
  });

  it('추적할 수 있도록 error 로그를 남긴다', async () => {
    const { service, loggedErrors } = setupService({ createLogFails: true });

    await service.sendDeliveryCompleteReportEmail(makeEmailBody(), BASE_USER, IP);

    expect(loggedErrors.some((message) => message.includes('activity_log'))).toBe(true);
  });

  it('발송 자체가 실패한 경우는 여전히 500 이다 (메일이 안 나갔으므로 재시도가 옳다)', async () => {
    const { service } = setupService({ createLogFails: true, sendSuccess: false });

    await expect(service.sendDeliveryCompleteReportEmail(makeEmailBody(), BASE_USER, IP)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });
});

describe('sendDestructionCertificateReportEmail — 카운터 대상 아님', () => {
  it('파기증명서는 대응 카운트 컬럼이 없으므로 카운터를 갱신하지 않는다', async () => {
    const { service } = setupService({ order: makeDestructionOrder() });

    const result = await service.sendDestructionCertificateReportEmail(makeEmailBody(), BASE_USER, IP);

    expect(result.success).toBe(true);
    expect(service.updateCalls).toHaveLength(0);
    expect(service.orderRepository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('카운터를 갱신하지 않아도 activity_log 는 남긴다', async () => {
    const { service } = setupService({ order: makeDestructionOrder() });

    await service.sendDestructionCertificateReportEmail(makeEmailBody(), BASE_USER, IP);

    expect(service.activityLogService.createLog).toHaveBeenCalledTimes(1);
  });
});

describe('메일 발송 실패 시', () => {
  it('발송완료리포트 — 카운터를 반영하지 않는다 (실패를 발행으로 집계 금지)', async () => {
    const { service } = setupService({ sendSuccess: false });

    await expect(service.sendDeliveryCompleteReportEmail(makeEmailBody(), BASE_USER, IP)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );

    expect(service.updateCalls).toHaveLength(0);
  });

  it('거래명세서 — 카운터를 반영하지 않는다', async () => {
    const { service } = setupService({ sendSuccess: false });

    await expect(service.sendTransactionStatementReportEmail(makeEmailBody(), BASE_USER, IP)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );

    expect(service.updateCalls).toHaveLength(0);
  });

  it('실패해도 activity_log 는 FAILURE 로 남는다 (기록이 카운터보다 먼저)', async () => {
    const { service } = setupService({ sendSuccess: false });

    await expect(service.sendDeliveryCompleteReportEmail(makeEmailBody(), BASE_USER, IP)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );

    expect(service.activityLogService.createLog).toHaveBeenCalledTimes(1);
    const logArg = service.activityLogService.createLog.mock.calls[0][0];
    expect(logArg.statusCode).toBe(500);
    expect(logArg.actionType).toBe('DELIVERY_COMPLETE_REPORT_EMAIL');
  });
});

describe('메일 발송 성공 후 카운터 갱신이 실패하면 (best-effort)', () => {
  // 이 시점엔 메일이 이미 고객사로 나갔다. 여기서 500 을 올리면 운영자가 "전송 실패"로 읽고
  // 재시도해 고객사가 같은 메일을 두 번 받는다. 집계 누락은 백필 가능하지만 중복 발송은 불가.
  it('예외를 삼키고 성공 응답을 돌려준다 (중복 발송 유발 금지)', async () => {
    const { service } = setupService({ counterUpdateFails: true });

    const result = await service.sendDeliveryCompleteReportEmail(makeEmailBody(), BASE_USER, IP);

    expect(result.success).toBe(true);
  });

  it('집계 실패를 추적 가능하도록 error 로그를 남긴다', async () => {
    const { service, loggedErrors } = setupService({ counterUpdateFails: true });

    await service.sendDeliveryCompleteReportEmail(makeEmailBody(), BASE_USER, IP);

    expect(loggedErrors).toHaveLength(1);
    expect(loggedErrors[0]).toContain('6142');
    expect(loggedErrors[0]).toContain('deliveryCompleteReportCount');
    expect(loggedErrors[0]).toContain('Deadlock');
  });

  it('거래명세서 경로도 동일하게 성공 응답한다', async () => {
    const { service } = setupService({ counterUpdateFails: true });

    const result = await service.sendTransactionStatementReportEmail(makeEmailBody(), BASE_USER, IP);

    expect(result.success).toBe(true);
  });

  it('메일 발송 자체가 실패한 경우는 여전히 500 이다 (best-effort 는 발송 이후에만 적용)', async () => {
    const { service } = setupService({ sendSuccess: false });

    await expect(service.sendDeliveryCompleteReportEmail(makeEmailBody(), BASE_USER, IP)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });
});

describe('발행 카운트 컬럼을 해석하지 못하면 (설정 오류)', () => {
  // 엔티티 프로퍼티를 리네임하면 ReportCounterColumns 의 문자열 리터럴과 어긋나는데
  // 컴파일이 못 잡는다. 이 실패를 메일 발송 '뒤'에 터뜨리면 "메일은 나갔는데 500" →
  // 운영자 재시도 → 고객사 중복 수신이 된다. 발송 전에 fail-fast 해야 한다.
  it('메일을 보내기 전에 실패한다 (중복 발송 원천 차단)', async () => {
    const { service } = setupService({ unknownColumn: true });

    await expect(service.sendDeliveryCompleteReportEmail(makeEmailBody(), BASE_USER, IP)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );

    expect(service.mailSendSmtp.send).not.toHaveBeenCalled();
  });

  it('activity_log 도 남기지 않는다 (아무 일도 일어나지 않은 상태)', async () => {
    const { service } = setupService({ unknownColumn: true });

    await expect(service.sendDeliveryCompleteReportEmail(makeEmailBody(), BASE_USER, IP)).rejects.toThrow();

    expect(service.activityLogService.createLog).not.toHaveBeenCalled();
    expect(service.updateCalls).toHaveLength(0);
  });

  it('어느 컬럼이 문제인지 메시지에 담는다', async () => {
    const { service } = setupService({ unknownColumn: true });

    await expect(service.sendDeliveryCompleteReportEmail(makeEmailBody(), BASE_USER, IP)).rejects.toThrow(
      /deliveryCompleteReportCount/,
    );
  });

  it('카운터를 쓰지 않는 파기증명서 경로는 영향받지 않는다', async () => {
    const { service } = setupService({ unknownColumn: true, order: makeDestructionOrder() });

    const result = await service.sendDestructionCertificateReportEmail(makeEmailBody(), BASE_USER, IP);

    expect(result.success).toBe(true);
    expect(service.mailSendSmtp.send).toHaveBeenCalledTimes(1);
  });
});

describe('주문이 존재하지 않으면', () => {
  it('메일을 보내지 않고 카운터도 건드리지 않는다', async () => {
    const { service } = setupService({ order: null });

    await expect(service.sendDeliveryCompleteReportEmail(makeEmailBody(), BASE_USER, IP)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(service.mailSendSmtp.send).not.toHaveBeenCalled();
    expect(service.updateCalls).toHaveLength(0);
  });
});
