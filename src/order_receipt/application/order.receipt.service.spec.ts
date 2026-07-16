import { BadRequestException, ForbiddenException } from '@nestjs/common';
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

    const autoOrderService: any = { run: jest.fn() };
    return {
      service: new OrderReceiptService(repository as any, fileService as any, autoOrderService),
      repository,
      fileService,
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

  it('blocks corporate delete while receipt is reviewing but keeps rejected delete available for owner', async () => {
    const reviewing = createService(makeReceipt({ userId: 20, status: OrderReceiptStatus.REVIEWING }));

    await expect(reviewing.service.delete(corporateUser(20), 100)).rejects.toThrow(BadRequestException);
    expect(reviewing.repository.softDelete).not.toHaveBeenCalled();

    const rejected = createService(makeReceipt({ userId: 20, status: OrderReceiptStatus.REJECTED }));

    await rejected.service.delete(corporateUser(20), 100);
    expect(rejected.repository.softDelete).toHaveBeenCalledWith(100);
  });

  it('blocks rejected transition through generic changeStatus and clears stale rejectReason on non-rejected statuses', async () => {
    const rejectedTarget = createService(makeReceipt({ status: OrderReceiptStatus.RECEIVED }));

    await expect(
      rejectedTarget.service.changeStatus(operationAdmin, 100, { status: OrderReceiptStatus.REJECTED }),
    ).rejects.toThrow(BadRequestException);
    expect(rejectedTarget.repository.save).not.toHaveBeenCalled();

    const approvedTarget = createService(
      makeReceipt({ status: OrderReceiptStatus.REJECTED, rejectReason: 'old reason' }),
    );

    await approvedTarget.service.changeStatus(operationAdmin, 100, { status: OrderReceiptStatus.APPROVED });

    expect(approvedTarget.receipt.rejectReason).toBeNull();
    expect(approvedTarget.receipt.status).toBe(OrderReceiptStatus.APPROVED);
    expect(approvedTarget.repository.save).toHaveBeenCalledWith(approvedTarget.receipt);
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
