import { ApiProperty } from '@nestjs/swagger';
import { OrderReceiptStatus } from '../../interface/order.receipt.status';

export class OrderReceiptDetailDto {
  @ApiProperty({ description: '주문접수 id' })
  id: number;

  @ApiProperty({ description: '등록자 user id' })
  userId: number;

  @ApiProperty({ description: '등록자명' })
  userName: string;

  @ApiProperty({ description: '제목' })
  title: string;

  @ApiProperty({ description: '상태 ex) RECEIVED, APPROVED, REJECTED' })
  status: OrderReceiptStatus;

  @ApiProperty({ description: '파일 url list' })
  filePathList: string[];

  @ApiProperty({ description: '반려 사유', nullable: true })
  rejectReason: string | null;

  @ApiProperty({ description: '확인사항 메모', nullable: true })
  memo: string | null;

  @ApiProperty({ description: '등록일 ex) yyyy-MM-ddTHH:mm:ss' })
  registerAt: string;

  @ApiProperty({ description: '처리일 ex) yyyy-MM-ddTHH:mm:ss', nullable: true })
  processedAt: string | null;

  @ApiProperty({ description: '처리자명', nullable: true })
  processedUserName: string | null;
}