import { GetListResDto } from '../../common/api/dto/get.list.res.dto';
import { ApiProperty } from '@nestjs/swagger';
import { SsgEventViewDto } from './dto/ssg.event.view.dto';

export class SsgEventGetListResDto extends GetListResDto {
  @ApiProperty({
    type: [SsgEventViewDto],
    description: '신세계 행사 list',
  })
  list: SsgEventViewDto[];
}

export class SsgEventGetValidListResDto {
  @ApiProperty({
    type: [SsgEventViewDto],
    description: '현재 유효한 신세계 행사 list',
  })
  list: SsgEventViewDto[];
}
