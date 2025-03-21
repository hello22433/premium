import { GetListResDto } from '../../common/api/dto/get.list.res.dto';
import { ApiProperty } from '@nestjs/swagger';
import { UserTaskHistoryViewDto } from './dto/user.task.history.view.dto';
import { UserTaskHistoryDetailViewDto } from './dto/user.task.history.detail.view.dto';

export class UserTaskHistoryGetListResDto extends GetListResDto {
  @ApiProperty({
    description: '고객관리 고객 list',
  })
  list: UserTaskHistoryViewDto[];
}

export class UserTaskHistoryGetDetailResDto {
  @ApiProperty({
    description: 'user id',
  })
  id: number;

  @ApiProperty({
    description: 'user email',
  })
  email: string;

  @ApiProperty({
    description: '고객사 등급',
  })
  businessGrade: string;

  @ApiProperty({
    description: '담당자 이름',
  })
  personName: string;

  @ApiProperty({
    description: '담당자 코드',
  })
  personCode: string;

  @ApiProperty({
    description: '담당자 분류',
  })
  personCategory: string;

  @ApiProperty({
    description: '담당자 이메일',
  })
  personEmail: string;

  @ApiProperty({
    description: '담당자 연락처',
  })
  personPhoneNumber: string;

  @ApiProperty({
    description: '고객관리 상담내역 list',
  })
  list: UserTaskHistoryDetailViewDto[];
}
