import { UserAuthMainEnum, UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';
import { ApiProperty } from '@nestjs/swagger';
import { IOrderSendMethod } from '../../order/interface/order.send.method';

export class UserGetAuthListResDto {
  @ApiProperty({
    description: '메인 메뉴 리스트',
  })
  mainMenuList: UserAuthMainEnum[];

  @ApiProperty({
    description: '서브 메뉴 리스트',
  })
  subMenuList: UserAuthSubEnum[];

  @ApiProperty({
    description: '허용 발신수단 목록',
    example: ['ALIM_TALK', 'SMS', 'EMAIL'],
    enum: IOrderSendMethod,
    isArray: true,
  })
  allowedSendMethods: IOrderSendMethod[];
}
