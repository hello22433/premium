import { GetListResDto } from '../../common/api/dto/get.list.res.dto';
import { CustomerServiceViewDto } from './dto/customer.service.view.dto';
import { ApiProperty } from '@nestjs/swagger';
import { CustomerServiceDetailViewDto } from './dto/customer.service.detail.view.dto';

export class CustomerServiceGetListResDto extends GetListResDto {
  @ApiProperty({
    description: 'cs list',
  })
  list: CustomerServiceViewDto[];
}

export class CustomerServiceGetDetailListResDto extends GetListResDto {
  @ApiProperty({
    description: 'cs detail list',
  })
  list: CustomerServiceDetailViewDto[];
}
