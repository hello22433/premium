import { GetListResDto } from '../../common/api/dto/get.list.res.dto';
import { ApiProperty } from '@nestjs/swagger';
import { SsgEventViewDto } from './dto/ssg.event.view.dto';

export class SsgEventGetListResDto extends GetListResDto {
  @ApiProperty({
    type: [SsgEventViewDto],
    description: '신세계 행사 list',
  })
  list: SsgEventViewDto[];

  @ApiProperty({
    description: '데이터가 없을 때 표시할 메시지',
    required: false,
  })
  emptyMessage?: string;
}

export class SsgEventGetValidListResDto {
  @ApiProperty({
    type: [SsgEventViewDto],
    description: '현재 유효한 신세계 행사 list',
  })
  list: SsgEventViewDto[];
}

export class SsgReservationRangeViewResDto {
  @ApiProperty({
    description: 'SSG 예약발송 가능 시작일 (yyyy-MM-dd). 미설정 시 null',
    nullable: true,
  })
  startDate: string | null;

  @ApiProperty({
    description: 'SSG 예약발송 가능 종료일 (yyyy-MM-dd). 미설정 시 null',
    nullable: true,
  })
  endDate: string | null;
}
