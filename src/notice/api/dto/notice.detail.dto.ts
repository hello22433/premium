import { NoticePriority } from '../../interface/notice.priority';
import { ApiProperty } from '@nestjs/swagger';

export class NoticeDetailDto {
  @ApiProperty({
    description: 'notice id',
  })
  id: number;

  @ApiProperty({
    description: 'notice 제목',
  })
  title: string;

  @ApiProperty({
    description: 'notice 내용',
  })
  content: string;

  @ApiProperty({
    description: '중요도 ex) 상: HIGH, 중: MEDIUM, 하: LOW',
  })
  priority: NoticePriority;

  @ApiProperty({
    description: '등록일 ex) yyyy-MM-ddTHH:mm:ss',
  })
  registerAt: string;

  @ApiProperty({
    description: '파일 url list',
  })
  filePathList: string[];
}
