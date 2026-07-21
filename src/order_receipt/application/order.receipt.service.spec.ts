import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  addTransactionalDataSource,
  deleteDataSourceByName,
  initializeTransactionalContext,
} from 'typeorm-transactional';
import { OrderReceiptService } from './order.receipt.service';
import { OrderReceiptStatus } from '../interface/order.receipt.status';
import { IUserAuthority } from '../../user/interface/user.authority';
import { ILoginUserInfo } from '../../auth/interface/login.user';

describe('OrderReceiptService access and status policy', () => {
  // approve()가 @Transactional 이므로 스텁 DataSource 등록(콜백만 실행)
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
  const corporateUser = (id: number): ILoginUserInfo => ({
    id,
    email: `user${id}@example.com`,
    authority: IUserAuthority.CORPORATE_ADMIN,
  });

  const operationAdmin: ILoginUserInfo = {
    id: 10,
    email: 'operation@example.com',
    authority: IUserAuthority.OPERATION_ADMIN,
  };

  const superAdmin: ILoginUserInfo = {
    id: 1,
    email: 'super@example.com',
    authority: IUserAuthority.SUPER_ADMIN,
  };

  const makeReceipt = (overrides: Record<string, any> = {}) => ({
    id: 100,
    userId: 20,
    title: 'receipt',
    status: OrderReceiptStatus.RECEIVED,
    filePath: '/files/a.pdf',
    rejectReason: null,
    requestNote: 'request',
    confirmNote: 'confirm',
    registerAt: new Date(),
    processedAt: null,
    processedUserId: null,
    user: {
      personName: 'owner',
      company: { businessName: 'company' },
    },
    processedUser: null,
    ...overrides,
  });

  const createService = (receipt: any) => {
    const repository = {
      findOne: jest.fn().mockResolvedValue(receipt),
      save: jest.fn(async (entity) => entity),
      softDelete: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    // getDetail 이 첨부 원본명 조회에 사용 — 이 spec 은 접근/상태 정책만 검증하므로 단순 stub
    const fileService = {
      getOriginalName: jest.fn().mockResolvedValue('a.pdf'),
      extractOriginalFileName: jest.fn().mockReturnValue('a.pdf'),
      extractStorageKey: jest.fn().mockReturnValue(''),
      isOwnStorageUrl: jest.fn().mockReturnValue(true),
      downloadWithPath: jest.fn(),
    };

    const autoOrderService: any = {
      run: jest.fn().mockResolvedValue({ files: [], alreadyCommitted: false }),
      getStoredResult: jest.fn().mockResolvedValue(null),
    };
    return {
      service: new OrderReceiptService(repository as any, fileService as any, autoOrderService),
      repository,
      fileService,
      autoOrderService,
      receipt,
    };
  };

  it('blocks corporate detail access to another user receipt', async () => {
    const { service } = createService(makeReceipt({ userId: 20 }));

    await expect((service.getDetail as any)(corporateUser(21), { id: 100 })).rejects.toThrow(ForbiddenException);
  });

  it('blocks corporate detail access to own receipt outside the 180 day list window', async () => {
    const oldRegisterAt = new Date();
    oldRegisterAt.setDate(oldRegisterAt.getDate() - 181);
    const { service } = createService(makeReceipt({ userId: 20, registerAt: oldRegisterAt }));

    await expect((service.getDetail as any)(corporateUser(20), { id: 100 })).rejects.toThrow(ForbiddenException);
  });

  it('requires operation admin authority for approve and reject', async () => {
    const { service } = createService(makeReceipt({ userId: 20, status: OrderReceiptStatus.RECEIVED }));

    await expect(service.approve(corporateUser(20), 100)).rejects.toThrow(ForbiddenException);
    await expect(service.reject(corporateUser(20), 100, { rejectReason: 'reason' })).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('승인 성공 시 자동주문 훅을 COMMIT 모드로 호출한다', async () => {
    const { service, autoOrderService, receipt } = createService(
      makeReceipt({ userId: 20, status: OrderReceiptStatus.RECEIVED }),
    );

    await service.approve(operationAdmin, 100);

    expect(autoOrderService.run).toHaveBeenCalledTimes(1);
    const [passedReceipt, passedUser, mode] = autoOrderService.run.mock.calls[0];
    expect(passedReceipt).toBe(receipt);
    expect(passedUser).toBe(operationAdmin);
    expect(mode).toBe('COMMIT');
  });

  it('자동주문 훅이 throw하면 승인 전체가 실패한다(원자성)', async () => {
    const { service, autoOrderService } = createService(
      makeReceipt({ userId: 20, status: OrderReceiptStatus.RECEIVED }),
    );
    autoOrderService.run.mockRejectedValueOnce(new Error('자동주문 실패'));

    await expect(service.approve(operationAdmin, 100)).rejects.toThrow('자동주문 실패');
  });

  it('동시 승인 경합으로 UNIQUE 위반(ER_DUP_ENTRY)이면 raw 500 대신 409(Conflict)', async () => {
    const { service, autoOrderService } = createService(
      makeReceipt({ userId: 20, status: OrderReceiptStatus.RECEIVED }),
    );
    autoOrderService.run.mockRejectedValueOnce({
      code: 'ER_DUP_ENTRY',
      message: "Duplicate entry '100-0-GENERAL' for key 'uq_receipt_file_type'",
    });

    await expect(service.approve(operationAdmin, 100)).rejects.toThrow(ConflictException);
  });

  it('접수 상태가 아니면(이미 APPROVED) 승인 거부 + 자동주문 훅 미호출', async () => {
    const { service, autoOrderService } = createService(
      makeReceipt({ userId: 20, status: OrderReceiptStatus.APPROVED }),
    );

    await expect(service.approve(operationAdmin, 100)).rejects.toThrow(BadRequestException);
    expect(autoOrderService.run).not.toHaveBeenCalled(); // 상태가드가 훅 앞에서 차단(재실행 방지)
  });

  it('미리보기는 운영관리자 이상만 허용', async () => {
    const { service } = createService(makeReceipt({ userId: 20, status: OrderReceiptStatus.RECEIVED }));

    await expect((service as any).previewAutoOrder(corporateUser(20), 100)).rejects.toThrow(ForbiddenException);
  });

  it('미리보기는 자동주문 훅을 DRY_RUN 모드로 호출한다', async () => {
    const { service, autoOrderService, receipt } = createService(
      makeReceipt({ userId: 20, status: OrderReceiptStatus.RECEIVED }),
    );

    await (service as any).previewAutoOrder(operationAdmin, 100);

    expect(autoOrderService.run).toHaveBeenCalledTimes(1);
    const [passedReceipt, passedUser, mode] = autoOrderService.run.mock.calls[0];
    expect(passedReceipt).toBe(receipt);
    expect(passedUser).toBe(operationAdmin);
    expect(mode).toBe('DRY_RUN');
  });

  it('승인된 접수(스냅샷 존재)에 미리보기 → 재계산 없이 저장 스냅샷(COMMITTED) 반환', async () => {
    const { service, autoOrderService } = createService(makeReceipt({ userId: 20, status: OrderReceiptStatus.APPROVED }));
    autoOrderService.getStoredResult.mockResolvedValueOnce({
      result: { files: [], alreadyCommitted: false },
      generatedAt: new Date('2026-08-05T05:30:00.000Z'),
    });

    const dto = await (service as any).previewAutoOrder(operationAdmin, 100);

    expect(dto.mode).toBe('COMMITTED');
    expect(dto.generatedAt).toBe('2026-08-05T05:30:00.000Z');
    expect(autoOrderService.run).not.toHaveBeenCalled(); // 재계산 안 함
  });

  it('미리보기는 fileIndexes를 훅에 전달하고 PREVIEW DTO를 반환한다', async () => {
    const { service, autoOrderService } = createService(makeReceipt({ userId: 20, status: OrderReceiptStatus.RECEIVED }));

    const dto = await (service as any).previewAutoOrder(operationAdmin, 100, [1, 2]);

    expect(autoOrderService.run.mock.calls[0][3]).toEqual([1, 2]); // 4번째 인자=fileIndexes
    expect(dto.mode).toBe('PREVIEW');
    expect(dto.receiptId).toBe(100);
    expect(dto.summary).toBeDefined();
  });

  it('승인은 COMMITTED DTO를 반환한다', async () => {
    const { service } = createService(makeReceipt({ userId: 20, status: OrderReceiptStatus.RECEIVED }));

    const dto = await service.approve(operationAdmin, 100);

    expect((dto as any).mode).toBe('COMMITTED');
    expect((dto as any).receiptId).toBe(100);
  });

  it('결과조회는 운영관리자 이상만 허용', async () => {
    const { service } = createService(makeReceipt({ userId: 20, status: OrderReceiptStatus.APPROVED }));
    await expect((service as any).getAutoOrderResult(corporateUser(20), 100)).rejects.toThrow(ForbiddenException);
  });

  it('결과조회: 스냅샷 없으면 404', async () => {
    const { service } = createService(makeReceipt({ userId: 20, status: OrderReceiptStatus.APPROVED }));
    await expect((service as any).getAutoOrderResult(operationAdmin, 100)).rejects.toThrow(NotFoundException);
  });

  it('결과조회: 저장 스냅샷을 COMMITTED DTO로 매핑', async () => {
    const { service, autoOrderService } = createService(makeReceipt({ userId: 20, status: OrderReceiptStatus.APPROVED }));
    autoOrderService.getStoredResult.mockResolvedValueOnce({
      result: { files: [], alreadyCommitted: false },
      generatedAt: new Date('2026-08-05T05:30:00.000Z'),
    });

    const dto = await (service as any).getAutoOrderResult(operationAdmin, 100);

    expect(dto.mode).toBe('COMMITTED');
    expect(dto.generatedAt).toBe('2026-08-05T05:30:00.000Z');
    expect(dto.summary.fileCount).toBe(0);
  });

  it('blocks corporate delete while receipt is reviewing but keeps rejected delete available for owner', async () => {
    const reviewing = createService(makeReceipt({ userId: 20, status: OrderReceiptStatus.REVIEWING }));

    await expect(reviewing.service.delete(corporateUser(20), 100)).rejects.toThrow(BadRequestException);
    expect(reviewing.repository.softDelete).not.toHaveBeenCalled();

    const rejected = createService(makeReceipt({ userId: 20, status: OrderReceiptStatus.REJECTED }));

    await rejected.service.delete(corporateUser(20), 100);
    expect(rejected.repository.softDelete).toHaveBeenCalledWith(100);
  });

  it('blocks rejected/approved transitions through generic changeStatus and clears stale rejectReason on non-rejected statuses', async () => {
    const rejectedTarget = createService(makeReceipt({ status: OrderReceiptStatus.RECEIVED }));

    await expect(
      rejectedTarget.service.changeStatus(operationAdmin, 100, { status: OrderReceiptStatus.REJECTED }),
    ).rejects.toThrow(BadRequestException);
    expect(rejectedTarget.repository.save).not.toHaveBeenCalled();

    // APPROVED도 상태변경으로는 불가(자동주문 실행/스냅샷 우회 방지) — 반드시 approve API를 타야 함
    const approvedBlocked = createService(makeReceipt({ status: OrderReceiptStatus.RECEIVED }));
    await expect(
      approvedBlocked.service.changeStatus(operationAdmin, 100, { status: OrderReceiptStatus.APPROVED }),
    ).rejects.toThrow(BadRequestException);
    expect(approvedBlocked.repository.save).not.toHaveBeenCalled();

    // 비-반려/비-승인 상태(REVIEWING) 전환은 stale rejectReason을 정리한다
    const reviewingTarget = createService(
      makeReceipt({ status: OrderReceiptStatus.REJECTED, rejectReason: 'old reason' }),
    );

    await reviewingTarget.service.changeStatus(operationAdmin, 100, { status: OrderReceiptStatus.REVIEWING });

    expect(reviewingTarget.receipt.rejectReason).toBeNull();
    expect(reviewingTarget.receipt.status).toBe(OrderReceiptStatus.REVIEWING);
    expect(reviewingTarget.repository.save).toHaveBeenCalledWith(reviewingTarget.receipt);
  });

  it('caps per-detail S3 metadata lookups at MAX_FILE_META_LOOKUP and falls back to key-derived names', async () => {
    const manyUrls = Array.from({ length: 12 }, (_, i) => `https://b.s3.amazonaws.com/private/20/k${i}-f${i}.xlsx`);
    const { service, fileService } = createService(makeReceipt({ filePath: manyUrls.join(',') }));

    const detail = await (service.getDetail as any)(operationAdmin, { id: 100 });

    expect(detail.files).toHaveLength(12);
    expect(fileService.getOriginalName).toHaveBeenCalledTimes(OrderReceiptService.MAX_FILE_META_LOOKUP);
    expect(fileService.extractOriginalFileName).toHaveBeenCalledTimes(12 - OrderReceiptService.MAX_FILE_META_LOOKUP);
  });

  it('allows admins to read details and super admin to delete reviewing receipts', async () => {
    const detail = createService(makeReceipt({ status: OrderReceiptStatus.REVIEWING }));
    await expect((detail.service.getDetail as any)(operationAdmin, { id: 100 })).resolves.toMatchObject({ id: 100 });

    const deletion = createService(makeReceipt({ status: OrderReceiptStatus.REVIEWING }));
    await deletion.service.delete(superAdmin, 100);
    expect(deletion.repository.softDelete).toHaveBeenCalledWith(100);
  });
});
