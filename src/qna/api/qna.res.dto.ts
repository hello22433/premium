import { GetListResDto } from '../../common/api/dto/get.list.res.dto';
import { ApiProperty } from '@nestjs/swagger';
import { QnaViewDto } from './dto/qna.view.dto';
import { QnaDetailDto } from './dto/qna.detail.dto';

export class QnaGetListResDto extends GetListResDto {
  @ApiProperty({
    description: 'qna 리스트',
  })
  list: QnaViewDto[];
}

export class QnaGetDetailResDto extends QnaDetailDto {}
