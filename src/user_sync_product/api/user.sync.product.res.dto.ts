import { ApiProperty } from '@nestjs/swagger';
import { UserSyncProductEventViewDto } from './dto/user.sync.product.event.view.dto';
import { GetListResDto } from '../../common/api/dto/get.list.res.dto';
import { UserSyncProductEventDetailDto } from './dto/user.sync.product.event.detail.dto';

export class UserSyncProductGetListResDto extends GetListResDto {
  @ApiProperty({
    description: '연동 상품 이벤트 list',
  })
  list: UserSyncProductEventViewDto[];
}

export class UserSyncProductGetDetailResDto {
  @ApiProperty({
    description: '연동 상품 list',
  })
  list: UserSyncProductEventDetailDto[];
}
