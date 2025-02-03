import { PagingReqDto } from '../../common/api/dto/pagination.req.dto';
import { IUserSettleCondition } from '../../user/interface/user.settle.condition';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsIn, IsNotEmpty, IsNumber, IsOptional, Matches } from 'class-validator';
import { IUserStatus } from '../../user/interface/user.status';
import { dateAtRegexp } from '../../common/domain/date.regexp';
import { UserManagementUpsertDto } from './dto/user.management.upsert.dto';
import { IUserAuthority } from '../../user/interface/user.authority';
import { Type } from 'class-transformer';

export class UserManagementGetNameListReqQueryDto {
  @ApiPropertyOptional({
    description: '유저 권한 ex) 운영담당자 : OPERATION_ADMIN, 고객사 (기업): CORPORATE_ADMIN',
  })
  // =============================================================
  @IsOptional()
  @IsIn(['OPERATION_ADMIN', 'CORPORATE_ADMIN'])
  authority?: IUserAuthority;
}

export class UserManagementGetListReqQueryDto extends PagingReqDto {
  @ApiPropertyOptional({
    description: '정산 조건 ex) 선정산 : PRE_PAYMENT, 후정산: POST_PAYMENT',
  })
  // =============================================================
  @IsOptional()
  @IsIn(['PRE_PAYMENT', 'POST_PAYMENT'])
  settleCondition?: IUserSettleCondition;

  @ApiPropertyOptional({
    description: '상태 ex) 사용 : USED, 미사용 : NOT_USED, 미승인 : NOT_APPROVED, 탈퇴 : LEAVE',
  })
  // =============================================================
  @IsOptional()
  @IsIn(['USED', 'NOT_USED', 'NOT_APPROVED', 'LEAVE'])
  status?: IUserStatus;

  @ApiPropertyOptional({
    description: '생성 시작일 ex) yyyy-MM-ddTHH:mm:ss',
  })
  // =============================================================
  @IsOptional()
  @Matches(dateAtRegexp)
  createdStartAt?: string;

  @ApiPropertyOptional({
    description: '생성 끝 일 ex) yyyy-MM-ddTHH:mm:ss',
  })
  // =============================================================
  @IsOptional()
  @Matches(dateAtRegexp)
  createdEndAt?: string;

  @ApiPropertyOptional({
    description: '유저 아이디 혹은 이메일',
  })
  // =============================================================
  @IsOptional()
  @IsEmail()
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
}

export class UserManagementGetDetailReqParamDto {
  @ApiProperty({
    description: '조회하고자 하는 유저 id',
  })
  // =============================================================
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  id: number;
}

export class UserManagementCreateReqDto extends UserManagementUpsertDto {
  @ApiProperty({
    description: '이메일',
  })
  // ===============================
  @IsNotEmpty()
  @IsEmail()
  email: string;

  @ApiProperty({
    description: '비밀번호',
  })
  // ===============================
  @IsNotEmpty()
  password: string;
}

export class UserManagementUpdateReqDto extends UserManagementUpsertDto {
  @ApiProperty({
    description: 'user id',
  })
  // ============================
  @IsNumber()
  @IsNotEmpty()
  id: number;

  @ApiPropertyOptional({
    description: 'user 상태 ',
  })
  // ============================
  @IsNotEmpty()
  @IsEnum(IUserStatus)
  status: IUserStatus;
}
