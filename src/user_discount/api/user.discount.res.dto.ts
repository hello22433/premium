import { GetListResDto } from '../../common/api/dto/get.list.res.dto';
import { ApiProperty } from '@nestjs/swagger';
import { UserDiscountViewDto } from './dto/user.discount.view.dto';

export class UserDiscountGetListResDto extends GetListResDto {
  @ApiProperty({
    description: '적용 할인 리스트',
  })
  list: UserDiscountViewDto[];
}
