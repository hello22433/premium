import { PagingReqDto } from '../../common/api/dto/pagination.req.dto';
import { IsEmail, IsEnum, IsIn, IsNotEmpty, IsNumber, IsOptional, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { dateAtRegexp } from '../../common/domain/date.regexp';
import { Type } from 'class-transformer';
import { IUserPersonCategory } from '../../user/interface/user.person.category';

export class UserTaskHistoryGetListReqQueryDto extends PagingReqDto {
  @ApiPropertyOptional({
    description: '생성 시작일 ex) yyyy-MM-ddTHH:mm:ss',
  })
  // =============================================================
  @Matches(dateAtRegexp)
  @IsOptional()
  createdStartAt?: string;

  @ApiPropertyOptional({
    description: '생성 끝 일 ex) yyyy-MM-ddTHH:mm:ss',
  })
  // =============================================================
  @Matches(dateAtRegexp)
  @IsOptional()
  createdEndAt?: string;

  @ApiPropertyOptional({
    description: '담당자 분류 <br>' + 'NEW : new<br>' + 'NORMAL : normal<br>' + 'VIP : VIP<br>' + 'VVIP : VVIP',
  })
  // ===================================
  @IsOptional()
  @IsEnum(IUserPersonCategory)
  personCategory?: IUserPersonCategory;

  @ApiPropertyOptional({
    description: '유저 아이디 혹은 이메일',
  })
  // =============================================================
  @IsOptional()
  email?: string;

  @ApiPropertyOptional({
    description: '고객사 명 (사업자 명)',
  })
  // =============================================================
  @IsOptional()
  businessName?: string;

  @ApiPropertyOptional({
    description: '담당자 명',
  })
  // =============================================================
  @IsOptional()
  personName?: string;

  @ApiPropertyOptional({
    description: '담당자 연락처',
  })
  // =============================================================
  @IsOptional()
  personPhoneNumber?: string;

  @ApiPropertyOptional({
    description: '완료 여부 <br>' + 'COMPLETED : 완료<br>' + 'INCOMPLETE : 미완료',
    enum: ['COMPLETED', 'INCOMPLETE'],
  })
  @IsOptional()
  @IsIn(['COMPLETED', 'INCOMPLETE'])
  completionStatus?: 'COMPLETED' | 'INCOMPLETE';
}

export class UserTaskHistoryGetDetailReqParamDto {
  @ApiProperty({
    description: '상담내역 조회하고자 하는 유저 id',
  })
  // =============================================================
  @IsNumber()
  @IsNotEmpty()
  @Type(() => Number)
  id: number;
}

export class UserTaskHistoryCreateReqDto {
  @ApiProperty({
    description: '상담내역 작성하고자 하는 유저 id',
  })
  // =============================================================
  @IsNumber()
  @IsNotEmpty()
  userId: number;

  @ApiProperty({
    description: '상담내역 내용',
  })
  // =================================
  @IsOptional()
  content?: string;
}

export class UserTaskHistoryDeleteReqDto {
  @ApiProperty({
    description: '소프트 삭제하려는 작업 기록의 ID',
  })
  @IsNumber()
  @IsNotEmpty()
  id: number;
}
