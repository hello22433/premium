import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { OrderReceiptService } from './order.receipt.service';
import { OrderReceiptStatus } from '../interface/order.receipt.status';
import { IUserAuthority } from '../../user/interface/user.authority';
import { ILoginUserInfo } from '../../auth/interface/login.user';

describe('OrderReceiptService access and status policy', () => {
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

    return {
      service: new OrderReceiptService(repository as any),
      repository,
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

  it('allows admins to read details and super admin to delete reviewing receipts', async () => {
    const detail = createService(makeReceipt({ status: OrderReceiptStatus.REVIEWING }));
    await expect((detail.service.getDetail as any)(operationAdmin, { id: 100 })).resolves.toMatchObject({ id: 100 });

    const deletion = createService(makeReceipt({ status: OrderReceiptStatus.REVIEWING }));
    await deletion.service.delete(superAdmin, 100);
    expect(deletion.repository.softDelete).toHaveBeenCalledWith(100);
  });
});
