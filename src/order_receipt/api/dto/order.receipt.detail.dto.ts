import { ApiProperty } from '@nestjs/swagger';
import { OrderReceiptStatus } from '../../interface/order.receipt.status';

export class OrderReceiptFileDto {
  @ApiProperty({ description: '다운로드용 파일 url (다운로드는 프록시 경유)' })
  url: string;

  @ApiProperty({ description: '원본 파일명 (표시·다운로드 파일명)' })
  name: string;
}

export class OrderReceiptDetailDto {
  @ApiProperty({ description: '주문접수 id' })
  id: number;

  @ApiProperty({ description: '등록자 user id' })
  userId: number;

  @ApiProperty({ description: '등록자명' })
  userName: string;

  @ApiProperty({ description: '등록자 고객사명', nullable: true })
  userCompanyName: string | null;

  @ApiProperty({ description: '제목' })
  title: string;

  @ApiProperty({ description: '상태 ex) RECEIVED, REVIEWING, APPROVED, REJECTED' })
  status: OrderReceiptStatus;

  @ApiProperty({ description: '파일 url list (하위호환용, 원본명 필요 시 files 사용)' })
  filePathList: string[];

  @ApiProperty({ description: '파일 목록(원본명 포함)', type: [OrderReceiptFileDto] })
  files: OrderReceiptFileDto[];

  @ApiProperty({ description: '반려 사유', nullable: true })
  rejectReason: string | null;

  @ApiProperty({ description: '요청사항', nullable: true })
  requestNote: string | null;

  @ApiProperty({ description: '확인사항', nullable: true })
  confirmNote: string | null;

  @ApiProperty({ description: '등록일 ex) yyyy-MM-ddTHH:mm:ss' })
  registerAt: string;

  @ApiProperty({ description: '처리일 ex) yyyy-MM-ddTHH:mm:ss', nullable: true })
  processedAt: string | null;

  @ApiProperty({ description: '처리자명', nullable: true })
  processedUserName: string | null;
}
