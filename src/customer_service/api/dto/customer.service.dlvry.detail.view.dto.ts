import { ApiProperty } from '@nestjs/swagger';
import { OrderDeliveryCouponStatus } from '../../../delivery/interface/order.delivery.coupon.status';
import { IOrderDeliveryStatus } from '../../../delivery/interface/order.delivery.status';

export class CustomerServiceDlvryDetailViewDto {
    @ApiProperty({
        description: 'order delivery Id',
    })
    orderDeliveryId: number;

    @ApiProperty({
        description: '고객사',
    })
    businessName: string;

    @ApiProperty({
        description: '발송담당자',
    })
    personName: string;

    @ApiProperty({
        description: '발송문구',
    })
    sendContent: string;

    @ApiProperty({
        description: '수신정보 (번호 혹은 이메일)',
    })
    deliveryTarget: string;

    @ApiProperty({
        description: '발송일자 ex)yyyy-MM-ddTHH:mm:ss',
    })
    sendRequestAt: string | null;

    @ApiProperty({
        description: '발신정보 (번호 혹은 이메일)',
    })
    fromPhoneNumber: string | null;

    @ApiProperty({
        description: '교환일자 ex)yyyy-MM-ddTHH:mm:ss',
    })
    tradeAt: string | null;

    @ApiProperty({
        description: '상품가격',
    })
    price: string;

    @ApiProperty({
        description: '교환처'
    })
    brandName: string;

    @ApiProperty({
        description: '협력사'
    })
    partnerCompanyName: string;

    @ApiProperty({
        description: '상품코드'
    })
    code: string;

    @ApiProperty({
        description: '핀 상태',
        enum: OrderDeliveryCouponStatus,
      })
      couponStatus: OrderDeliveryCouponStatus;
    
    @ApiProperty({
        description: '발송 상태',
        enum: IOrderDeliveryStatus,
    })
    status: IOrderDeliveryStatus;

    @ApiProperty({
        description: '발송에러코드',
    })
    apiErrorMessage: string | null;

    @ApiProperty({
        description: '핀번호',
    })
    barCode: string | null;

    @ApiProperty({
        description: '유효일수'
    })
    expireDay: string;
}