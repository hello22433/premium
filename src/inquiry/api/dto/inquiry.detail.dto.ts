import { ApiProperty } from '@nestjs/swagger';

export class InquiryDetailDto {
  @ApiProperty({
    description: '1:1 문의 순번',
  })
  id: number;

  @ApiProperty({
    description: '1:1 등록 일 ex) yyyy-MM-ddTHH:mm:ss',
  })
  createdAt: string;

  @ApiProperty({
    description: '고객사 명',
  })
  userBusinessName: string;

  @ApiProperty({
    description: '담당자 명',
  })
  userPersonName: string;

  @ApiProperty({
    description: '이메일 주소',
  })
  userEmail: string;

  @ApiProperty({
    description: '전화번호',
  })
  userPersonPhoneNumber: string;

  @ApiProperty({
    description: '진행 상태 ex) 등록: REGISTER, 진행: PROGRESS, 완료: COMPLETE',
  })
  status: string;

  @ApiProperty({
    description: '제목',
  })
  title: string;

  @ApiProperty({
    description: '내용',
  })
  content: string;

  @ApiProperty({
    description: '첨부파일 list',
  })
  filePath: string[];

  @ApiProperty({
    description: '답글 내용',
  })
  replyContent: string | null;
}
