import { OrderFromPhoneViewDto } from './dto/order.from.phone.view.dto';
import { ApiProperty } from '@nestjs/swagger';
import { OrderFromEmailViewDto } from './dto/order.from.email.view.dto';
import { OrderFromDefinitionType, OrderFromRequestStatus } from '../interface/order.from.definition.type';

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

// ==================== 관리자용 응답 DTO ====================

export class OrderFromAdminViewDto {
  @ApiProperty({ description: 'ID' })
  id: number;

  @ApiProperty({ description: '타입 (PHONE/EMAIL)' })
  type: OrderFromDefinitionType;

  @ApiProperty({ description: '발신번호 또는 이메일' })
  from: string;

  @ApiProperty({ description: '사용자 ID' })
  userId: number;

  @ApiProperty({ description: '요청 상태 (PENDING/APPROVED/REJECTED)' })
  requestStatus: OrderFromRequestStatus;

  @ApiProperty({ description: '생성일' })
  createdAt: Date;
}

export class OrderFromAdminListResDto {
  @ApiProperty({
    description: '발신번호/이메일 전체 리스트 (삭제/거절 제외)',
    type: [OrderFromAdminViewDto],
  })
  list: OrderFromAdminViewDto[];

  @ApiProperty({ description: '전체 갯수' })
  totalCount: number;

  @ApiProperty({ description: '전체 페이지 수' })
  totalPage: number;
}
