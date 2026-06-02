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

export class SsgRemoteAmountResDto {
  @ApiProperty({ description: '주문시도 총액 (CUST_INFO 전체 SETAMT 합)' })
  tryAmt: number;

  @ApiProperty({ description: '발급성공 총액 (처리구분01 + 결과00)' })
  successAmt: number;

  @ApiProperty({ description: '발급실패 총액 (처리구분01 + 결과≠00)' })
  failAmt: number;

  @ApiProperty({ description: '미처리 총액 (tryAmt - successAmt - failAmt)' })
  pendingAmt: number;
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
