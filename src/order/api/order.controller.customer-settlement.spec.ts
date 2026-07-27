import { ForbiddenException } from '@nestjs/common';
import { OrderController } from './order.controller';
import { IOrderType } from '../interface/order.type';
import { IUserAuthority } from '../../user/interface/user.authority';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';

/**
 * GET /order/customer-settlement — 발송관리 세부권한 게이트
 *
 * 이 엔드포인트는 주문 id 만으로 고객사 잔여한도를 노출하므로,
 * 목록(/order/list)과 동일한 SEND_GENERAL / SEND_SSG 검증이 반드시 선행돼야 한다.
 * (권한 없는 운영관리자가 id 순회로 잔액을 캐는 경로 차단)
 */

const user = { id: 1, email: 'op@test.com', authority: IUserAuthority.OPERATION_ADMIN } as any;

const setup = (authorityValidator = jest.fn().mockResolvedValue(undefined)) => {
  const orderService = { getCustomerSettlement: jest.fn().mockResolvedValue({ list: [] }) } as any;
  const controller = new OrderController(orderService, {} as any, { authorityValidator } as any, {} as any);

  return { controller, orderService, authorityValidator };
};

describe('OrderController getCustomerSettlement — 권한 게이트', () => {
  it('type=GENERAL → SEND_GENERAL 권한을 검증한다', async () => {
    const { controller, orderService, authorityValidator } = setup();

    await controller.getCustomerSettlement(user, { ids: [1, 2], type: IOrderType.GENERAL } as any);

    expect(authorityValidator).toHaveBeenCalledWith(user, UserAuthSubEnum.SEND_GENERAL);
    expect(orderService.getCustomerSettlement).toHaveBeenCalledTimes(1);
  });

  it('type=SSG → SEND_SSG 권한을 검증한다', async () => {
    const { controller, orderService, authorityValidator } = setup();

    await controller.getCustomerSettlement(user, { ids: [1], type: IOrderType.SSG } as any);

    expect(authorityValidator).toHaveBeenCalledWith(user, UserAuthSubEnum.SEND_SSG);
    expect(orderService.getCustomerSettlement).toHaveBeenCalledTimes(1);
  });

  it('발송관리 권한이 없으면 403 이며 정산정보 조회 자체를 하지 않는다', async () => {
    const authorityValidator = jest.fn().mockRejectedValue(new ForbiddenException('권한이 없습니다.'));
    const { controller, orderService } = setup(authorityValidator);

    await expect(
      controller.getCustomerSettlement(user, { ids: [1], type: IOrderType.GENERAL } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(orderService.getCustomerSettlement).not.toHaveBeenCalled();
  });
});
