import { PagingReqDto } from '../../common/api/dto/pagination.req.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';
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
  @ArrayMaxSize(10, { message: '첨부파일은 최대 10개까지 등록할 수 있습니다.' })
  @IsString({ each: true })
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

  @ApiProperty({
    description: '첨부파일 list (수정은 개수 제한 없음)',
  })
  // =================================
  // create 의 @ArrayMaxSize(10) 을 상속하면, 상한 도입 전(무제한 시절) 만들어진 첨부 11개↑ 문서가
  // 제목만 고쳐도 400 이 되어 영구 수정 불가해진다(FE 가 기존 목록 전체를 되보내므로). 수정은 관리자
  // 전용 신뢰 작업이라 개수 상한 없이 재정의한다(신규 생성만 create 에서 10개로 제한).
  @IsArray()
  @IsString({ each: true })
  override filePath: string[];
}

export class UserDriveFileDownloadReqParamDto {
  @ApiProperty({
    description: '문서(user drive) id',
  })
  // =================================
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  id: number;
}

export class UserDriveFileDownloadReqQueryDto {
  @ApiProperty({
    description: '다운로드할 첨부파일 url (해당 문서에 첨부된 url 이어야 함)',
  })
  // =================================
  @IsNotEmpty()
  @IsString()
  fileUrl: string;
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
