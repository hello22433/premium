import { ApiProperty } from '@nestjs/swagger';
import { IUserSyncProductStatus } from '../../interface/user.sync.product.status';

export class UserSyncProductEventViewDto {
  @ApiProperty({
    description: 'event id',
  })
  id: number;

  @ApiProperty({
    description: '고객사 명',
  })
  userBusinessName: string;

  @ApiProperty({
    description: '이벤트 코드 ',
  })
  code: string;

  @ApiProperty({
    description: '이벤트명',
  })
  name: string;

  @ApiProperty({
    description: '등록 상품 갯수',
  })
  syncProductCount: number;

  @ApiProperty({
    description: '운영 상태 ex) ACTIVE: 사용, STOPPED: 일시중지, CLOSED: 종료',
  })
  status: IUserSyncProductStatus;
}
