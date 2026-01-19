import { GetListResDto } from '../../common/api/dto/get.list.res.dto';
import { CustomerServiceViewDto } from './dto/customer.service.view.dto';
import { ApiProperty } from '@nestjs/swagger';
import { CustomerServiceDetailViewDto } from './dto/customer.service.detail.view.dto';
import { CustomerServiceDlvryDetailViewDto } from './dto/customer.service.dlvry.detail.view.dto';

export class CustomerServiceGetListResDto extends GetListResDto {
  @ApiProperty({
    description: 'cs list',
  })
  list: CustomerServiceViewDto[];

  @ApiProperty({
    description: '총 금액 (쿠폰금액 합계)',
  })
  totalPrice: number;
}

export class CustomerServiceGetDetailListResDto extends GetListResDto {
  @ApiProperty({
    description: 'cs detail list',
  })
  list: CustomerServiceDetailViewDto[];
}

export class CustomerServiceGetDetailResDto {
  @ApiProperty({
    description: 'cs detail',
    type: CustomerServiceDlvryDetailViewDto,
  })
  detail: CustomerServiceDlvryDetailViewDto;
}

export class CustomerServiceUnmaskedDeliveryTargetResDto {
  @ApiProperty({
    description: '평문 수신정보 (전화번호 또는 이메일)',
  })
  deliveryTarget: string;
}
