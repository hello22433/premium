import { ForbiddenException } from '@nestjs/common';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import { SettleController } from './settle.controller';
import { IUserAuthority } from '../../user/interface/user.authority';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  createReadStream: jest.fn(),
  unlink: jest.fn(),
}));

describe('SettleController', () => {
  const user = {
    id: 1,
    email: 'operator@example.com',
    authority: IUserAuthority.OPERATION_ADMIN,
  };
  const dto = {
    orderId: 10,
    settleStatus: 'SETTLE_COMPLETE',
  } as any;

  const createController = () => {
    const settleService = {
      getUserPerDetail: jest.fn().mockResolvedValue({ list: [], totalCount: 0 }),
      updateUserPerOrder: jest.fn().mockResolvedValue({ ok: true }),
    };
    const activityLogService = {};
    const authService = {
      authorityValidator: jest.fn().mockResolvedValue(undefined),
    };
    const walletReadService = {
      getSettlementCodeSnapshot: jest.fn(),
      getSettlementCodeUsage: jest.fn(),
    };

    const controller = new SettleController(
      settleService as any,
      activityLogService as any,
      authService as any,
      walletReadService as any,
    );

    return { controller, settleService, authService, walletReadService };
  };

  const createDownloadController = () => {
    const settleService = {
      mobileExcelDownload: jest.fn().mockResolvedValue({
        fileName: 'mobile_2026.xlsx',
        filePath: '/tmp/mobile_2026.xlsx',
      }),
      getUserExcelDownload: jest.fn().mockResolvedValue({
        fileName: 'user_2026.xlsx',
        filePath: '/tmp/user_2026.xlsx',
        recordCount: 10,
      }),
    };
    const activityLogService = {};
    const authService = {
      authorityValidator: jest.fn().mockResolvedValue(undefined),
    };
    const walletReadService = {};

    const controller = new SettleController(
      settleService as any,
      activityLogService as any,
      authService as any,
      walletReadService as any,
    );

    return { controller, settleService, authService };
  };

  const downloadUser = { id: 1, email: 'admin@test.com', authority: IUserAuthority.OPERATION_ADMIN } as any;
  const downloadReq = { ip: '127.0.0.1', headers: { 'user-agent': 'jest' } } as any;

  describe('mobileExcelDownload — 스트림 error 핸들러 (D3-29)', () => {
    let mockStream: EventEmitter & { pipe: jest.Mock };

    beforeEach(() => {
      mockStream = Object.assign(new EventEmitter(), { pipe: jest.fn() });
      (fs.createReadStream as jest.Mock).mockReturnValue(mockStream);
      (fs.unlink as unknown as jest.Mock).mockImplementation((_path: string, cb: any) => cb && cb(null));
    });

    afterEach(() => {
      jest.clearAllMocks();
    });

    it('스트림 오류 발생 시 헤더 미전송이면 500 JSON 응답을 보낸다', async () => {
      const { controller } = createDownloadController();
      jest.spyOn((controller as any).logger, 'error').mockImplementation(() => {});

      const res = {
        headersSent: false,
        setHeader: jest.fn(),
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        destroy: jest.fn(),
      } as any;

      await controller.mobileExcelDownload(downloadUser, {} as any, downloadReq, res);
      mockStream.emit('error', new Error('디스크 오류'));

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ message: '파일 다운로드 중 오류가 발생했습니다.' });
      expect(res.destroy).not.toHaveBeenCalled();
      expect(fs.unlink as unknown as jest.Mock).toHaveBeenCalledWith('/tmp/mobile_2026.xlsx', expect.any(Function));
    });

    it('스트림 오류 발생 시 헤더 기전송이면 소켓을 강제 종료한다', async () => {
      const { controller } = createDownloadController();
      jest.spyOn((controller as any).logger, 'error').mockImplementation(() => {});

      const res = {
        headersSent: true,
        setHeader: jest.fn(),
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        destroy: jest.fn(),
      } as any;

      await controller.mobileExcelDownload(downloadUser, {} as any, downloadReq, res);
      mockStream.emit('error', new Error('디스크 오류'));

      expect(res.destroy).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
      expect(fs.unlink as unknown as jest.Mock).toHaveBeenCalledWith('/tmp/mobile_2026.xlsx', expect.any(Function));
    });

    it('정상 스트림 종료 시 임시파일을 삭제한다', async () => {
      const { controller } = createDownloadController();

      const res = {
        headersSent: false,
        setHeader: jest.fn(),
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        destroy: jest.fn(),
      } as any;

      await controller.mobileExcelDownload(downloadUser, {} as any, downloadReq, res);
      mockStream.emit('close');

      expect(fs.unlink as unknown as jest.Mock).toHaveBeenCalledWith('/tmp/mobile_2026.xlsx', expect.any(Function));
      expect(res.destroy).not.toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  const createOtherServiceController = () => {
    const settleService = {
      createOtherServiceSale: jest.fn().mockResolvedValue({ id: 1 }),
      updateOtherServiceSale: jest.fn().mockResolvedValue({ id: 1 }),
      getShippingStorageList: jest.fn().mockResolvedValue([]),
      createShippingStorage: jest.fn().mockResolvedValue({ id: 1 }),
      createSaleType: jest.fn().mockResolvedValue({ id: 1 }),
      getSaleTypeList: jest.fn().mockResolvedValue([]),
      getAdminUserList: jest.fn().mockResolvedValue([]),
      getOtherDetail: jest.fn().mockResolvedValue({ id: 1 }),
    };
    const activityLogService = {};
    const authService = {
      authorityValidator: jest.fn().mockResolvedValue(undefined),
    };
    const walletReadService = {};

    const controller = new SettleController(
      settleService as any,
      activityLogService as any,
      authService as any,
      walletReadService as any,
    );

    return { controller, settleService, authService };
  };

  describe('#35/#38 — SERVICE_SALES 권한 검증', () => {
    const cases: Array<{
      label: string;
      invoke: (ctrl: SettleController) => Promise<any>;
      serviceFn: keyof ReturnType<typeof createOtherServiceController>['settleService'];
    }> = [
      {
        label: 'createOtherServiceSale',
        invoke: (ctrl) => ctrl.createOtherServiceSale(user as any, {} as any),
        serviceFn: 'createOtherServiceSale',
      },
      {
        label: 'updateOtherServiceSale',
        invoke: (ctrl) => ctrl.updateOtherServiceSale(user as any, {} as any),
        serviceFn: 'updateOtherServiceSale',
      },
      {
        label: 'getShippingStorageList',
        invoke: (ctrl) => ctrl.getShippingStorageList(user as any, {} as any),
        serviceFn: 'getShippingStorageList',
      },
      {
        label: 'createShippingStorage',
        invoke: (ctrl) => ctrl.createShippingStorage(user as any, {} as any),
        serviceFn: 'createShippingStorage',
      },
      {
        label: 'createSaleType',
        invoke: (ctrl) => ctrl.createSaleType(user as any, {} as any),
        serviceFn: 'createSaleType',
      },
      {
        label: 'getSaleTypeList',
        invoke: (ctrl) => ctrl.getSaleTypeList(user as any, {} as any),
        serviceFn: 'getSaleTypeList',
      },
      {
        label: 'getAdminUserList',
        invoke: (ctrl) => ctrl.getAdminUserList(user as any, {} as any),
        serviceFn: 'getAdminUserList',
      },
      {
        label: 'getOtherDetail',
        invoke: (ctrl) => ctrl.getOtherDetail(user as any, {} as any),
        serviceFn: 'getOtherDetail',
      },
    ];

    describe.each(cases)('$label', ({ invoke, serviceFn }) => {
      it('SERVICE_SALES 권한을 검증한 뒤 서비스를 호출한다', async () => {
        const { controller, settleService, authService } = createOtherServiceController();

        await invoke(controller);

        expect(authService.authorityValidator).toHaveBeenCalledWith(user, UserAuthSubEnum.SERVICE_SALES);
        expect(settleService[serviceFn]).toHaveBeenCalled();
      });

      it('권한 검증 실패 시 서비스를 호출하지 않는다', async () => {
        const { controller, settleService, authService } = createOtherServiceController();
        authService.authorityValidator.mockRejectedValue(new ForbiddenException('권한이 없습니다.'));

        await expect(invoke(controller)).rejects.toBeInstanceOf(ForbiddenException);

        expect(settleService[serviceFn]).not.toHaveBeenCalled();
      });
    });
  });

  describe('updateUserPerOrder', () => {
    it('정산상태 변경 전 SETTLE_USER_MANAGE 권한을 검증한다', async () => {
      const { controller, settleService, authService } = createController();

      await controller.updateUserPerOrder(user, dto);

      expect(authService.authorityValidator).toHaveBeenCalledWith(user, UserAuthSubEnum.SETTLE_USER_MANAGE);
      expect(settleService.updateUserPerOrder).toHaveBeenCalledWith(dto);
    });

    it('권한 검증에 실패하면 정산상태 변경을 실행하지 않는다', async () => {
      const { controller, settleService, authService } = createController();
      authService.authorityValidator.mockRejectedValue(new ForbiddenException('권한이 없습니다.'));

      await expect(controller.updateUserPerOrder(user, dto)).rejects.toBeInstanceOf(ForbiddenException);

      expect(settleService.updateUserPerOrder).not.toHaveBeenCalled();
    });
  });

  describe('getUserPerDetail', () => {
    it('상세 조회 전 SETTLE_USER_MANAGE 권한을 검증한다', async () => {
      const { controller, settleService, authService } = createController();

      await controller.getUserPerDetail(user, { userId: 10 } as any);

      expect(authService.authorityValidator).toHaveBeenCalledWith(user, UserAuthSubEnum.SETTLE_USER_MANAGE);
      expect(settleService.getUserPerDetail).toHaveBeenCalledWith({ userId: 10 });
    });

    it('권한 검증에 실패하면 상세 조회를 실행하지 않는다', async () => {
      const { controller, settleService, authService } = createController();
      authService.authorityValidator.mockRejectedValue(new ForbiddenException('권한이 없습니다.'));

      await expect(controller.getUserPerDetail(user, { userId: 10 } as any)).rejects.toBeInstanceOf(ForbiddenException);

      expect(settleService.getUserPerDetail).not.toHaveBeenCalled();
    });
  });
});
