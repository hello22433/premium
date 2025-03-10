import { ApiProperty } from '@nestjs/swagger';
import { IQnaStatus } from '../../interface/qna.status';

export class QnaDetailDto {
  @ApiProperty({
    description: 'qna id',
  })
  id: number;

  @ApiProperty({
    description: '등록일 ex) yyyy-MM-dd',
  })
  registerDate: string;

  @ApiProperty({
    description: 'qna 등록한 고객사(사업자) 명',
  })
  businessName: string;

  @ApiProperty({
    description: 'qna 등록한 담당자 명',
  })
  personName: string;

  @ApiProperty({
    description: '유저 이메일',
  })
  userEmail: string;

  @ApiProperty({
    description: '유저 핸드폰번호',
  })
  userPhone: string;

  @ApiProperty({
    description: '상태 ex) WAIT: 답변대기, OK: 답변완료',
  })
  status: IQnaStatus;

  @ApiProperty({
    description: '첨부파일 url list',
  })
  filePathList: string[];

  @ApiProperty({
    description: '제목',
  })
  title: string;

  @ApiProperty({
    description: '내용',
  })
  content: string;

  @ApiProperty({
    description: '관리자 답변',
  })
  answer: string | null;
}
