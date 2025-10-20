import { OrderViewDto } from './dto/order.view.dto';
import { ApiProperty } from '@nestjs/swagger';
import { GetListResDto } from '../../common/api/dto/get.list.res.dto';
import { IOrderType } from '../interface/order.type';
import { IOrderSendMethod } from '../interface/order.send.method';
import { OrderDetailProductDto, OrderPdfDetailProductDto } from './dto/order.detail.product.dto';
import { IOrderStatus } from '../interface/order.status';
import { OrderSettleViewDto } from './dto/order.settle.view.dto';
import { OrderEmailSendType } from '../domain/order.email.send.type';
import { OrderCustomerViewDto } from './dto/order.customer.view.dto';
import { OrderCompleteReportViewDto } from './dto/order.complete.report.view.dto';
import { OrderDashboardViewDto } from './dto/order.dashboard.view.dto';

export class OrderGetListResDto extends GetListResDto {
  @ApiProperty({
    description: '주문 list',
  })
  list: OrderViewDto[];
}

export class OrderCreateTempResDto {
  @ApiProperty({
    description: '생성된 order id',
  })
  id: number;
}

export class OrderGetDetailResDto {
  @ApiProperty({
    description: 'order id',
  })
  id: number;

  @ApiProperty({
    description: '등록일 ex) yyyy-MM-ddTHH:mm:ss',
  })
  registerAt: string;

  @ApiProperty({
    description: '이벤트 명',
  })
  eventName: string;

  @ApiProperty({
    description: '주문 관리 타입',
  })
  type: IOrderType;

  @ApiProperty({
    description: '주문 발송 방법',
  })
  sendMethod: IOrderSendMethod;

  @ApiProperty({
    description: '꼬리 광고 null 일시 무',
  })
  sendTailText: string | null;

  @ApiProperty({
    description: '개인정보 파기 요청 60, 180이 아닐시 기타로 표기',
  })
  requestToDestroyPersonalInfoDay: number;

  @ApiProperty({
    description: '발신 번호',
  })
  fromPhoneNumber: string | null;

  @ApiProperty({
    description: '발신 이메일',
  })
  fromEmail: string | null;

  @ApiProperty({
    description: '전송 제목',
  })
  sendTitle: string;

  @ApiProperty({
    description: 'QR, URL',
  })
  emailSendType: OrderEmailSendType | null;

  @ApiProperty({
    description: '이메일 사용 방법',
  })
  useEmailContent: string | null;

  @ApiProperty({
    description: '전송 내용',
  })
  sendContent: string;

  @ApiProperty({
    description: '발송 요청 시각 ex) yyyy-MM-ddTHH:mm:ss',
    nullable: true,
  })
  sendRequestAt: string | null;

  @ApiProperty({
    description: '발송 방식 ex) IMMEDIATE : 즉시, RESERVE : 예약',
  })
  sendType: string | null;

  @ApiProperty({
    description: '상단 이미지 경로',
  })
  topImagePath?: string;

  @ApiProperty({
    description: '중간 이미지 경로',
  })
  midImagePath?: string;

  @ApiProperty({
    enum: IOrderStatus,
    description: 'status',
  })
  status: IOrderStatus;

  @ApiProperty({
    description: '신세계 상품 유효기간',
  })
  couponExpiration: number | null;

  @ApiProperty({
    description: '독려 문자 일',
  })
  encourageDay: number | null;

  @ApiProperty({
    description: '상품 정보 리스트',
  })
  productList: OrderDetailProductDto[];
}

export class OrderGetDeliveryCompleteReportDetailResDto {
  @ApiProperty({
    description: 'order id',
  })
  id: number;

  @ApiProperty({
    description: '등록일 ex) yyyy-MM-ddTHH:mm:ss',
  })
  registerAt: string;

  @ApiProperty({
    description: '이벤트 명',
  })
  eventName: string;

  @ApiProperty({
    description: '주문 관리 타입',
  })
  type: IOrderType;

  @ApiProperty({
    description: '주문 발송 방법',
  })
  sendMethod: IOrderSendMethod;

  @ApiProperty({
    description: '발신 번호',
  })
  fromPhoneNumber: string | null;

  @ApiProperty({
    description: '발신 이메일',
  })
  fromEmail: string | null;

  @ApiProperty({
    description: '전송 제목',
  })
  sendTitle: string;

  @ApiProperty({
    description: '전송 내용',
  })
  sendContent: string;

  @ApiProperty({
    description: '발송 요청 시각 ex) yyyy-MM-ddTHH:mm:ss',
    nullable: true,
  })
  sendRequestAt: string | null;

  @ApiProperty({
    enum: IOrderStatus,
    description: 'status',
  })
  status: IOrderStatus;

  @ApiProperty({
    description: '신세계 상품 유효기간',
  })
  couponExpiration: number | null;

  @ApiProperty({
    description: '상품 정보 리스트',
  })
  productList: OrderPdfDetailProductDto[];
}

export class OrderGetDeliveryCompleteReportResDto extends OrderGetDeliveryCompleteReportDetailResDto {
  @ApiProperty({
    description: 'pdf 파운로드시 파일명',
  })
  fileName: string;

  @ApiProperty({
    description: '고객사 정보',
  })
  userInfo: OrderCustomerViewDto;

  @ApiProperty({
    description: '개인정보 파기 요청일',
  })
  requestToDestroyPersonalInfoDay: number;
}

export class OrderGetOrderCompleteReportResDto extends OrderCompleteReportViewDto {}

export class OrderDeliveryConfirmed {
  @ApiProperty({
    description: '메세지 ex) 전체 성공 : success, 일부 실패가 존재하는 경우 : fail',
  })
  message: string;
}

export class OrderGetSettleGetListResDto extends GetListResDto {
  @ApiProperty({
    description: '정산 정보 list',
  })
  list: OrderSettleViewDto[];
}

export class OrderGetMyOrderHistoryResDto extends OrderDashboardViewDto {}

export class OrderGetPreviousContentResDto {
  @ApiProperty({
    description: '발송 제목',
  })
  sendTitle: string | null;

  @ApiProperty({
    description: '발송 내용 ',
  })
  sendContent: string | null;
}
