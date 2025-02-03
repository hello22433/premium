import { NoticePriority } from '../../interface/notice.priority';
import { ApiProperty } from '@nestjs/swagger';

export class NoticeViewDto {
  @ApiProperty({
    description: '공지사항 id',
  })
  id: number;

  @ApiProperty({
    description: '공지사항 작성 user id',
  })
  userId: number;

  @ApiProperty({
    description: '공지사항 등록자',
  })
  userName: string;

  @ApiProperty({
    description: '공지사항 중요도 ex) 상: HIGH, 중: MEDIUM, 하: LOW',
  })
  priority: NoticePriority;

  @ApiProperty({
    description: '공지사항 제목',
  })
  title: string;

  @ApiProperty({
    description: '첨부파일 유무',
  })
  isFile: boolean;

  @ApiProperty({
    description: '첨부파일 개수',
  })
  fileCount: number;

  @ApiProperty({
    description: '등록일 ex) yyyy-MM-ddTHH:mm:ss',
  })
  registerAt: string;
}
