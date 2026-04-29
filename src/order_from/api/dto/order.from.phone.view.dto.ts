import { ApiProperty } from '@nestjs/swagger';
import { OrderFromRequestStatus, TelecomCertType } from '../../interface/order.from.definition.type';

export class OrderFromPhoneViewDto {
  @ApiProperty({ description: 'from phone id' })
  id: number;

  @ApiProperty({ description: '발신 휴대폰 번호' })
  from: string;

  @ApiProperty({ description: '기본 발신번호 여부' })
  isDefault: boolean;

  @ApiProperty({ description: '요청 상태', enum: OrderFromRequestStatus })
  requestStatus: OrderFromRequestStatus;

  @ApiProperty({ description: '통신이용증명 유형', enum: TelecomCertType, nullable: true })
  telecomCertType: TelecomCertType | null;

  @ApiProperty({ description: '통신이용증명 파일 URL', nullable: true })
  telecomCertFile: string | null;

  @ApiProperty({ description: '거절 사유 (REJECTED 상태일 때)', nullable: true })
  rejectReason: string | null;

  @ApiProperty({ description: '등록일' })
  createdAt: Date;
}
