import { OrderViewDto } from './dto/order.view.dto';
import { ApiProperty } from '@nestjs/swagger';
import { GetListResDto } from '../../common/api/dto/get.list.res.dto';
import { IOrderType } from '../interface/order.type';
import { OrderDetailProductDto, OrderPdfDetailProductDto } from './dto/order.detail.product.dto';
import { IOrderStatus } from '../interface/order.status';
import { OrderSettleViewDto } from './dto/order.settle.view.dto';
import { OrderCustomerViewDto } from './dto/order.customer.view.dto';
import { OrderCompleteReportViewDto } from './dto/order.complete.report.view.dto';
import { OrderDashboardViewDto } from './dto/order.dashboard.view.dto';
import { UserSettlePeriodConditionEnum } from '../../user/interface/user.settle.period.condition.enum';

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
    description: '상품 정보 리스트',
  })
  productList: OrderDetailProductDto[];

  @ApiProperty({
    description:
      '정산 조건 월 타입 ex) CURRENT_MONTH: 당월, NEXT_MONTH: 익월, NEXT_MONTH_AFTER: 익익월, DELIVERY_DATE: 발송일',
  })
  settlePeriodCondition: UserSettlePeriodConditionEnum | null;

  @ApiProperty({
    description: '발송 조건 일',
  })
  settlePeriodCount: number | null;

  @ApiProperty({
    description: '선정산 여부 (true: 선정산, false: 후정산)',
  })
  isPreSettle: boolean;

  @ApiProperty({
    description: '주문 취소 사유',
    nullable: true,
  })
  cancelReason: string | null;

  @ApiProperty({
    description: '주문 취소 일시 ex) yyyy-MM-ddTHH:mm:ss',
    nullable: true,
  })
  canceledAt: string | null;

  @ApiProperty({
    description: '해당 주문의 총 발송 실패 건수',
  })
  totalFailCount: number;

  @ApiProperty({
    description: '과금 대상 담당자 ID (대행주문 시)',
    nullable: true,
  })
  clientUserId: number | null;

  @ApiProperty({
    description: '과금 대상 담당자명 (대행주문 시)',
    nullable: true,
  })
  clientUserName: string | null;

  @ApiProperty({
    description: '과금 대상 담당자 회사명 (대행주문 시)',
    nullable: true,
  })
  clientCompanyName: string | null;

  @ApiProperty({
    description: '운영담당자 ID',
    nullable: true,
  })
  operationUserId: number | null;

  @ApiProperty({
    description: '운영담당자명',
    nullable: true,
  })
  operationUserName: string | null;
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

  @ApiProperty({
    nullable: true,
    description: '실제 발송 시간 ex) yyyy-MM-ddTHH:mm:ss',
  })
  actualSendAt: string | null;

  @ApiProperty({
    nullable: true,
    description: '발송 방법 ex) ALIM_TALK, SMS, EMAIL',
  })
  sendMethod: string | null;

  @ApiProperty({
    nullable: true,
    description: '발송 제목',
  })
  sendTitle: string | null;

  @ApiProperty({
    nullable: true,
    description: '발송 내용',
  })
  sendContent: string | null;

  @ApiProperty({
    nullable: true,
    description: '발송 요청 시간 ex) yyyy-MM-ddTHH:mm:ss',
  })
  sendRequestAt: string | null;

  @ApiProperty({
    nullable: true,
    description: '발신 전화번호',
  })
  fromPhoneNumber: string | null;

  @ApiProperty({
    nullable: true,
    description: '발신 이메일',
  })
  fromEmail: string | null;

  @ApiProperty({
    nullable: true,
    description: '독려 문자 발송 일',
  })
  encourageDay: number | null;
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

export class OrderReportHistoryItemDto {
  @ApiProperty({
    description: '다운로드한 사용자 이메일',
  })
  userEmail: string;

  @ApiProperty({
    description: '다운로드 일시',
  })
  createdAt: string;

  @ApiProperty({
    description: '발행 소스 (DOCUMENT: 문서함, DIRECT: 직접발행)',
    nullable: true,
  })
  source: string | null;

  @ApiProperty({
    description: '이메일 수신자 (이메일 발송 시)',
    nullable: true,
  })
  to: string | null;

  @ApiProperty({
    description: '이메일 참조 (이메일 발송 시)',
    nullable: true,
  })
  cc: string | null;
}

export class OrderGetReportHistoryResDto {
  @ApiProperty({
    type: [OrderReportHistoryItemDto],
    description: '다운로드 이력 목록',
  })
  list: OrderReportHistoryItemDto[];
}
