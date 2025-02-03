import { NoticeViewDto } from './dto/notice.view.dto';
import { GetListResDto } from '../../common/api/dto/get.list.res.dto';
import { ApiProperty } from '@nestjs/swagger';
import { NoticeDetailDto } from './dto/notice.detail.dto';

export class NoticeGetListResDto extends GetListResDto {
  @ApiProperty({
    description: '공지사항 리스트',
  })
  list: NoticeViewDto[];
}

export class NoticeGetDetailResDto extends NoticeDetailDto {}
