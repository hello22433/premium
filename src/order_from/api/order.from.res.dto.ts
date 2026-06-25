import { OrderFromPhoneViewDto } from './dto/order.from.phone.view.dto';
import { ApiProperty } from '@nestjs/swagger';
import { OrderFromEmailViewDto } from './dto/order.from.email.view.dto';
import {
  OrderFromDefinitionType,
  OrderFromRequestStatus,
  TelecomCertType,
} from '../interface/order.from.definition.type';

export class OrderFromGetPhoneListResDto {
  @ApiProperty({
    description: '발신 핸드폰 번호 리스트',
  })
  list: OrderFromPhoneViewDto[];

  @ApiProperty({
    description: 'MMS 발신번호 선택목록에서 시스템 기본번호(16443614) 숨김 여부',
  })
  hideSystemFromPhone: boolean;
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

  @ApiProperty({ description: '사용자 이메일' })
  userEmail: string;

  @ApiProperty({ description: '요청 상태 (PENDING/APPROVED/REJECTED)' })
  requestStatus: OrderFromRequestStatus;

  @ApiProperty({ description: '통신이용증명 유형', enum: TelecomCertType, nullable: true })
  telecomCertType: TelecomCertType | null;

  @ApiProperty({ description: '통신이용증명 파일 URL', nullable: true })
  telecomCertFile: string | null;

  @ApiProperty({ description: '거절 사유', nullable: true })
  rejectReason: string | null;

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

  @ApiProperty({ description: '현재 페이지' })
  currentPage: number;
}

// ==================== 사용자 관리탭 응답 DTO ====================

export class OrderFromPhoneManageListResDto {
  @ApiProperty({
    description: '발신번호 관리 리스트 (모든 상태 포함)',
    type: [OrderFromPhoneViewDto],
  })
  list: OrderFromPhoneViewDto[];

  @ApiProperty({
    description: 'MMS 발신번호 선택목록에서 시스템 기본번호(16443614) 숨김 여부',
  })
  hideSystemFromPhone: boolean;
}
