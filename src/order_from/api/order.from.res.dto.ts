import { OrderFromPhoneViewDto } from './dto/order.from.phone.view.dto';
import { ApiProperty } from '@nestjs/swagger';
import { OrderFromEmailViewDto } from './dto/order.from.email.view.dto';

export class OrderFromGetPhoneListResDto {
  @ApiProperty({
    description: '발신 핸드폰 번호 리스트',
  })
  list: OrderFromPhoneViewDto[];
}

export class OrderFromGetEmailListResDto {
  @ApiProperty({
    description: '발신 이메일 리스트',
  })
  list: OrderFromEmailViewDto[];
}
