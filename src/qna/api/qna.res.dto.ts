import { GetListResDto } from '../../common/api/dto/get.list.res.dto';
import { ApiProperty } from '@nestjs/swagger';
import { QnaViewDto } from './dto/qna.view.dto';
import { QnaDetailDto } from './dto/qna.detail.dto';
import { QnaDashboardViewDto } from './dto/qna.dashboard.view.dto';

export class QnaGetListResDto extends GetListResDto {
  @ApiProperty({
    description: 'qna 리스트',
  })
  list: QnaViewDto[];
}

export class QnaGetDetailResDto extends QnaDetailDto {}
export class QnaGetMyQnaHistoryResDto extends QnaDashboardViewDto {}

export class QnaBulkDeleteResDto {
  @ApiProperty({
    description: '실제 삭제된 건수',
  })
  deletedCount: number;

  @ApiProperty({
    description: '실제 삭제된 qna id 목록',
    type: [Number],
  })
  deletedIds: number[];
}
