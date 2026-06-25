import { ApiProperty } from '@nestjs/swagger';
import { OrderReceiptStatus } from '../../interface/order.receipt.status';

export class OrderReceiptViewDto {
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

  @ApiProperty({ description: '첨부파일 유무' })
  isFile: boolean;

  @ApiProperty({ description: '첨부파일 개수' })
  fileCount: number;

  @ApiProperty({ description: '등록일 ex) yyyy-MM-ddTHH:mm:ss' })
  registerAt: string;

  @ApiProperty({ description: '처리일 ex) yyyy-MM-ddTHH:mm:ss', nullable: true })
  processedAt: string | null;
}
