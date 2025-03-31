import { IOrderStatus } from '../../../order/interface/order.status';
import { ApiProperty } from '@nestjs/swagger';

export class CustomerServiceViewDto {
  @ApiProperty({
    description: '발송 일자 및 시각 ex) yyyy-MM-ddTHH:mm:ss',
  })
  sendRequestAt: string;

  @ApiProperty({
    description: 'order Id',
  })
  id: number;

  @ApiProperty({
    description: 'order Product id Id',
  })
  orderProductMappingId: number;

  @ApiProperty({
    description: '이벤트 명',
  })
  eventName: string;

  @ApiProperty({
    description: '상품 코드',
  })
  productCode: string;

  @ApiProperty({
    description: '상품 이름',
  })
  productName: string;

  @ApiProperty({
    description: '발송 번호',
  })
  fromPhoneNumber: string | null;

  @ApiProperty({
    description: '발송 이메일',
  })
  fromEmail: string | null;

  @ApiProperty({
    description: '발송 상태',
  })
  status: IOrderStatus;
}
