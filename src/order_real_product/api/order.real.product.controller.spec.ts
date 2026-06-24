import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { OrderRealProductController } from './order.real.product.controller';
import { IOrderSection } from '../../order/interface/order.section';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';

describe('OrderRealProductController access control', () => {
  it('담당자 리스트 조회 API는 인증 가드를 적용한다', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, OrderRealProductController.prototype.getAdminUserList);

    expect(guards).toContain(AuthUserAuthorizationGuard);
  });

  it('배송 추적 상세 조회 API는 인증 사용자 정보를 서비스에 전달한다', () => {
    const orderRealProductService = {
      getDeliveryTrackingDetail: jest.fn(),
    };
    const controller = new OrderRealProductController(orderRealProductService as any, {} as any, {} as any);
    const user = { id: 100 };
    const getParam = { id: 20 };

    controller.getDeliveryTrackingDetail(user as any, getParam as any);

    expect(orderRealProductService.getDeliveryTrackingDetail).toHaveBeenCalledWith(user, getParam);
  });
});

describe('OrderRealProductController excelDownload section 권한 검증', () => {
  const user = { id: 1 } as any;

  const createController = (authorityValidator: jest.Mock) => {
    const authService = { authorityValidator };
    const service = { excelDownload: jest.fn() };
    return new OrderRealProductController(service as any, {} as any, authService as any);
  };

  it('section ORDER이면 ORDER_REAL_ITEM 권한을 검증한다', async () => {
    const authorityValidator = jest.fn().mockResolvedValue(undefined);
    const controller = createController(authorityValidator);
    const body = { section: IOrderSection.ORDER } as any;
    const res = { setHeader: jest.fn(), on: jest.fn() } as any;

    await controller.excelDownload(user, body, res).catch(() => {});

    expect(authorityValidator).toHaveBeenCalledWith(user, UserAuthSubEnum.ORDER_REAL_ITEM);
  });

  it('section SHIPPING이면 SEND_REAL_ITEM 권한을 검증한다', async () => {
    const authorityValidator = jest.fn().mockResolvedValue(undefined);
    const controller = createController(authorityValidator);
    const body = { section: IOrderSection.SHIPPING } as any;
    const res = { setHeader: jest.fn(), on: jest.fn() } as any;

    await controller.excelDownload(user, body, res).catch(() => {});

    expect(authorityValidator).toHaveBeenCalledWith(user, UserAuthSubEnum.SEND_REAL_ITEM);
  });

  it('section ORDER에서 권한 없으면 서비스를 호출하지 않는다', async () => {
    const authorityValidator = jest.fn().mockRejectedValue(new Error('Forbidden'));
    const service = { excelDownload: jest.fn() };
    const controller = new OrderRealProductController(service as any, {} as any, { authorityValidator } as any);
    const body = { section: IOrderSection.ORDER } as any;
    const res = { setHeader: jest.fn(), on: jest.fn() } as any;

    await controller.excelDownload(user, body, res).catch(() => {});

    expect(service.excelDownload).not.toHaveBeenCalled();
  });

  it('section SHIPPING에서 권한 없으면 서비스를 호출하지 않는다', async () => {
    const authorityValidator = jest.fn().mockRejectedValue(new Error('Forbidden'));
    const service = { excelDownload: jest.fn() };
    const controller = new OrderRealProductController(service as any, {} as any, { authorityValidator } as any);
    const body = { section: IOrderSection.SHIPPING } as any;
    const res = { setHeader: jest.fn(), on: jest.fn() } as any;

    await controller.excelDownload(user, body, res).catch(() => {});

    expect(service.excelDownload).not.toHaveBeenCalled();
  });
});
