import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { PartnerCompanyExternHistoryService } from './partner.company.extern.history.service';
import { DeliveryFailureSotReader, DeliveryFailureSotView } from './delivery.failure.sot.reader';
import { PartnerCompanyExternHistoryEntity } from '../../entity/partner.company.extern.history.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { DeliveryWorkflowEntity } from '../../entity/delivery.workflow.entity';
import { MessageAttemptEntity } from '../../entity/message.attempt.entity';
import { PinIssueCommandEntity } from '../../entity/pin.issue.command.entity';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { DeliveryBatchService } from '../../delivery/application/delivery.batch.service';
import { PartnerCompanyExternService } from '../../partner_company_extern/application/partner.company.extern.service';
import { SsgInsertStateService } from '../../delivery/application/ssg-insert-state.service';
import { DeliveryCutoverGuardService } from '../../delivery/application/delivery-cutover-guard.service';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';
import { DeliveryWorkflowStatus } from '../../delivery/interface/delivery.workflow.status';
import { MessageAttemptStatus, MessageAttemptType } from '../../delivery/interface/message.attempt.status';
import { PinIssueCommandStatus, PartnerResponseClass } from '../../delivery/interface/pin.issue.command.status';
import { FailType } from '../api/partner.company.extern.history.res.dto';

/**
 * §8 화면 SoT 고정 / §10 3단계(실측 검증·노출) 단위 검증.
 *
 * - 컷오버 전환 건은 `delivery_workflow` + 하위 시도만 근거로 렌더된다(legacy status 미참조).
 * - 미전환 건은 기존 legacy 렌더가 그대로 유지된다(회귀 방지).
 * - legacy 미러와 workflow 판정이 어긋나면 workflow 를 채택하고 불일치 건수를 노출한다.
 * - legacy 일괄 재발송 대상에서 전환 건은 제외된다(§9 인벤토리 #2).
 */
describe('실패내역 화면 SoT 렌더', () => {
  const makeDelivery = (overrides: Partial<OrderDeliveryEntity> = {}): OrderDeliveryEntity =>
    ({
      id: 100,
      status: IOrderDeliveryStatus.FAIL,
      barCode: '8503',
      deliveryTarget: null,
      transactionId: 'ENM1D100',
      actualSendAt: new Date('2026-08-01T10:00:00'),
      failedAt: null,
      updatedAt: new Date('2026-08-01T10:00:00'),
      resendAt: null,
      orderProductMapping: {
        order: { code: 'ORD-1', eventName: '이벤트' },
        product: { partnerCompany: { type: IPartnerCompanyType.GALAXIA } },
      },
      ...overrides,
    }) as unknown as OrderDeliveryEntity;

  const makeSot = (overrides: Partial<DeliveryFailureSotView> = {}): DeliveryFailureSotView => ({
    workflowStatus: DeliveryWorkflowStatus.FAILED_FINAL,
    workflowStatusKo: '최종 실패',
    opsReviewReason: null,
    pinIssueFailed: false,
    pinIssued: true,
    resent: false,
    autoResendCount: 1,
    manualResendCount: 0,
    channel: 'SMS',
    sendReason: 'INITIAL',
    failureCode: {
      code: 'GEMTEK_RESULT_504',
      rawCode: '504',
      description: '이통사 만료(expired) — 접수 약 24시간 뒤 확정',
      opsAction: '자동 재발송 대상. 자동 재발송이 비활성이면 수동 재발송',
      autoResendEligible: true,
    },
    lastResolvedAt: new Date('2026-08-02T09:30:00'),
    deliveredAt: null,
    ...overrides,
  });

  const buildSut = async (rows: OrderDeliveryEntity[], sotMap: Map<number, DeliveryFailureSotView>) => {
    const qb: Record<string, jest.Mock> = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      withDeleted: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([rows, rows.length]),
      getRawMany: jest.fn().mockResolvedValue(rows.map((r) => ({ orderDelivery_id: r.id }))),
    };
    const historyQb = {
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PartnerCompanyExternHistoryService,
        {
          provide: getRepositoryToken(PartnerCompanyExternHistoryEntity),
          useValue: { createQueryBuilder: jest.fn(() => historyQb) },
        },
        { provide: getRepositoryToken(OrderDeliveryEntity), useValue: { createQueryBuilder: jest.fn(() => qb) } },
        { provide: CryptoCipher, useValue: { safeDecryptDeliveryTarget: jest.fn().mockReturnValue(null) } },
        { provide: DeliveryBatchService, useValue: {} },
        { provide: PartnerCompanyExternService, useValue: {} },
        { provide: SsgInsertStateService, useValue: {} },
        { provide: DeliveryCutoverGuardService, useValue: {} },
        { provide: DeliveryFailureSotReader, useValue: { loadMigrated: jest.fn().mockResolvedValue(sotMap) } },
      ],
    }).compile();

    return { sut: module.get(PartnerCompanyExternHistoryService), qb };
  };

  it('전환 건은 workflow SoT 로 렌더하고 legacy 재발송 버튼을 막는다', async () => {
    const { sut } = await buildSut([makeDelivery()], new Map([[100, makeSot()]]));

    const res = await sut.getHistoryList({ page: 1, take: 20 } as never);
    const row = res.list[0];

    expect(row.sotSource).toBe('WORKFLOW');
    expect(row.workflowStatus).toBe(DeliveryWorkflowStatus.FAILED_FINAL);
    expect(row.failType).toBe(FailType.SEND_FAIL);
    expect(row.errorCode).toBe('GEMTEK_RESULT_504');
    expect(row.opsAction).toContain('자동 재발송');
    expect(row.autoResendCount).toBe(1);
    expect(row.channel).toBe('SMS');
    expect(row.lastResolvedAt).toBe('2026-08-02T09:30:00');
    expect(row.resendable).toBe(false);
    expect(row.resendBlockReason).toContain('MANUAL_RESEND');
  });

  it('전환 건의 workflow 판정과 legacy status 미러가 어긋나면 workflow 를 채택하고 불일치로 집계한다', async () => {
    // legacy 미러는 COMPLETE 인데 workflow 는 최종 실패 → 미러 불일치 1건
    const { sut } = await buildSut(
      [makeDelivery({ status: IOrderDeliveryStatus.COMPLETE })],
      new Map([[100, makeSot()]]),
    );

    const res = await sut.getHistoryList({ page: 1, take: 20 } as never);

    expect(res.list[0].failType).toBe(FailType.SEND_FAIL);
    expect(res.list[0].mirrorMismatch).toBe(true);
    expect(res.mirrorMismatchCount).toBe(1);
  });

  it('전환 건이라도 workflow 와 legacy 미러가 일치하면 불일치로 집계하지 않는다', async () => {
    const { sut } = await buildSut([makeDelivery()], new Map([[100, makeSot()]]));

    const res = await sut.getHistoryList({ page: 1, take: 20 } as never);

    expect(res.list[0].mirrorMismatch).toBe(false);
    expect(res.mirrorMismatchCount).toBe(0);
  });

  it('미전환 건은 기존 legacy 렌더를 유지하고 재발송 버튼이 열린다', async () => {
    const { sut } = await buildSut([makeDelivery({ barCode: null })], new Map());

    const res = await sut.getHistoryList({ page: 1, take: 20 } as never);
    const row = res.list[0];

    expect(row.sotSource).toBe('LEGACY');
    expect(row.failType).toBe(FailType.PIN_ISSUE_FAIL);
    expect(row.workflowStatus).toBeNull();
    expect(row.resendable).toBe(true);
    expect(row.mirrorMismatch).toBe(false);
    expect(res.mirrorMismatchCount).toBe(0);
  });

  it('legacy 일괄 재발송 대상 조회는 전환 건 제외 술어를 건다', async () => {
    const { sut, qb } = await buildSut([makeDelivery()], new Map());

    await sut.getResendTargetIds({} as never);

    const conditions = qb.andWhere.mock.calls.map((call) => String(call[0]));
    expect(conditions).toContain('`wf`.`cutover_migrated_at` IS NULL');
  });
});

describe('DeliveryFailureSotReader', () => {
  const workflow = (overrides: Partial<DeliveryWorkflowEntity> = {}) =>
    ({
      orderDeliveryId: 100,
      workflowStatus: DeliveryWorkflowStatus.FAILED_FINAL,
      opsReviewReason: null,
      stateEnteredAt: new Date('2026-08-02T09:00:00'),
      deliveredAt: null,
      ...overrides,
    }) as DeliveryWorkflowEntity;

  const attempt = (overrides: Partial<MessageAttemptEntity> = {}) =>
    ({
      id: '1',
      orderDeliveryId: 100,
      channel: 'SMS',
      attemptType: MessageAttemptType.INITIAL,
      status: MessageAttemptStatus.FAILED_FINAL,
      sendReason: 'INITIAL',
      gemtekResult: '504',
      resolvedAt: new Date('2026-08-02T09:30:00'),
      ...overrides,
    }) as MessageAttemptEntity;

  const pinCommand = (overrides: Partial<PinIssueCommandEntity> = {}) =>
    ({
      id: '1',
      orderDeliveryId: 100,
      status: PinIssueCommandStatus.SUCCEEDED,
      partnerResponseCode: null,
      responseClass: null,
      resolvedAt: new Date('2026-08-01T10:00:00'),
      ...overrides,
    }) as PinIssueCommandEntity;

  const buildReader = (
    workflows: DeliveryWorkflowEntity[],
    attempts: MessageAttemptEntity[],
    pinCommands: PinIssueCommandEntity[],
  ) =>
    new DeliveryFailureSotReader(
      { find: jest.fn().mockResolvedValue(workflows) } as never,
      { find: jest.fn().mockResolvedValue(attempts) } as never,
      { find: jest.fn().mockResolvedValue(pinCommands) } as never,
    );

  it('마지막 실패 결과 코드를 Gemtek 네임스페이스로 표기하고 자동 재발송 횟수를 센다', async () => {
    const reader = buildReader(
      [workflow()],
      [
        attempt({ id: '1', status: MessageAttemptStatus.RETRIED, resolvedAt: new Date('2026-08-02T09:10:00') }),
        attempt({ id: '2', attemptType: MessageAttemptType.AUTO_504 }),
      ],
      [pinCommand()],
    );

    const view = (await reader.loadMigrated([100])).get(100)!;

    expect(view.failureCode?.code).toBe('GEMTEK_RESULT_504');
    expect(view.failureCode?.autoResendEligible).toBe(true);
    expect(view.autoResendCount).toBe(1);
    expect(view.resent).toBe(true);
    expect(view.pinIssued).toBe(true);
    expect(view.pinIssueFailed).toBe(false);
    expect(view.lastResolvedAt).toEqual(new Date('2026-08-02T09:30:00'));
  });

  it('PIN 발급이 확정 실패면 협력사 응답 네임스페이스로 표기한다', async () => {
    const reader = buildReader(
      [workflow()],
      [],
      [
        pinCommand({
          status: PinIssueCommandStatus.TERMINAL,
          partnerResponseCode: '4032',
          responseClass: PartnerResponseClass.TERMINAL,
        }),
      ],
    );

    const view = (await reader.loadMigrated([100])).get(100)!;

    expect(view.pinIssueFailed).toBe(true);
    expect(view.pinIssued).toBe(false);
    expect(view.failureCode?.code).toBe('PARTNER_RESPONSE_4032');
    expect(view.failureCode?.opsAction).toContain('재시도 무의미');
  });

  it('미전환 건(cutover_migrated_at IS NULL)은 조회 대상에서 제외되어 맵에 없다', async () => {
    const reader = buildReader([], [], []);

    expect((await reader.loadMigrated([100])).size).toBe(0);
  });

  it('성공 코드 0 은 실패 코드로 표기하지 않는다', async () => {
    const reader = buildReader(
      [workflow({ workflowStatus: DeliveryWorkflowStatus.COMPLETED })],
      [attempt({ status: MessageAttemptStatus.SUCCEEDED, gemtekResult: '0' })],
      [pinCommand()],
    );

    const view = (await reader.loadMigrated([100])).get(100)!;

    expect(view.failureCode).toBeNull();
  });
});
