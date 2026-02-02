import { PagingReqDto } from '../../common/api/dto/pagination.req.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsEnum, IsNotEmpty, IsNumber, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { IUserDriveStatus } from '../interface/user.drive.status';

export class UserDriveGetListReqDto extends PagingReqDto {}

export class UserDriveGetDetailReqParamDto {
  @ApiProperty({
    description: 'user drive id',
  })
  // =================================
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  id: number;
}

export class UserDriveCreateReqDto {
  @ApiProperty({
    description: '수신 받을 user id',
  })
  // =================================
  @IsNotEmpty()
  @Min(1)
  @IsNumber()
  receiverId: number;

  @ApiProperty({
    description: '제목',
  })
  // =================================
  @IsNotEmpty()
  title: string;

  @ApiProperty({
    description: '내용',
  })
  // =================================
  @IsNotEmpty()
  content: string;

  @ApiProperty({
    description: '첨부파일 list',
  })
  // =================================
  @IsArray()
  filePath: string[];

  @ApiPropertyOptional({
    description: '상태값 ex) 임시저장: DRAFT, 등록: REGISTER (기본값: REGISTER)',
    enum: IUserDriveStatus,
    default: IUserDriveStatus.REGISTER,
  })
  // =================================
  @IsOptional()
  @IsEnum(IUserDriveStatus)
  status?: IUserDriveStatus;
}

export class UserDriveUpdateReqDto extends UserDriveCreateReqDto {
  @ApiProperty({
    description: '수정할 user drive id',
  })
  // =================================
  @IsNotEmpty()
  @IsNumber()
  id: number;

  @ApiProperty({
    description: '상태값 ex) 등록: REGISTER, 진행: PROGRESS, 완료: COMPLETE',
    enum: IUserDriveStatus,
  })
  // =================================
  @IsNotEmpty()
  @IsEnum(IUserDriveStatus)
  override status: IUserDriveStatus;
}

export class UserDriveReplyReqDto {
  @ApiProperty({
    description: '답변 할 user drive id',
  })
  // =================================
  @IsNotEmpty()
  @IsNumber()
  id: number;

  @ApiProperty({
    description: '답변 내용',
  })
  // =================================
  @IsNotEmpty()
  replyContent: string;
}
