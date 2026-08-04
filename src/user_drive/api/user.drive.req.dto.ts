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

/**
 * 등록/수정이 규칙까지 동일한 필드만 담는다. 두 API 가 실제로 같은 값을 요구하는 것만 여기 둔다.
 *
 * ★ 자식이 이 필드들을 재선언하면 안 된다:
 *   class-validator 는 부모 데코레이터를 자식에 상속시키되, 자식이 같은 프로퍼티를 재선언하면
 *   `(propertyName, type)` 쌍으로만 중복을 제거한다(MetadataStorage.getTargetValidationMetadatas).
 *   일반 검증기(@IsArray/@ArrayMaxSize/@IsString...)는 전부 type='customValidation' 이라 재선언이
 *   부모 것을 통째로 교체해 버리고, 반대로 @IsOptional 만 type='conditionalValidation' 이라 교체되지
 *   않고 살아남는다. 즉 "재선언해서 일부만 바꾸기" 는 데코레이터 종류에 따라 결과가 갈린다.
 *   (실제로 그 함정을 밟았었다 — update 가 @IsNotEmpty status 를 재선언했지만 create 의 @IsOptional 이
 *    살아남아 status 생략/null 이 검증을 통과했다.)
 *   그래서 규칙이 다른 필드는 상속하지 않고 각 DTO 가 직접, 전부 선언한다.
 */
export class UserDriveWriteBaseReqDto {
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
    description: '첨부파일 list (등록·수정 모두 최대 10개)',
  })
  // =================================
  // 등록/수정에 같은 상한을 건다. 한때 수정만 상한을 뺐었는데, 그건 "상한 도입 전에 만들어진 첨부
  // 11개↑ 문서가 제목만 고쳐도 400 이 되어 영구 수정 불가" 를 피하려던 임시 조치였다.
  // 운영 DB 실측(2026-08-04)으로 그런 문서가 없음을 확인해 통일한다 —
  //   첨부 11개↑ 문서 0건 / 최대 첨부 2개 (user_drive, deleted_at IS NULL).
  // 신규 생성이 10개로 막히므로 이 상한을 넘는 문서는 앞으로도 생기지 않는다.
  @IsArray()
  @ArrayMaxSize(10, { message: '첨부파일은 최대 10개까지 등록할 수 있습니다.' })
  @IsString({ each: true })
  filePath: string[];
}

export class UserDriveCreateReqDto extends UserDriveWriteBaseReqDto {
  @ApiPropertyOptional({
    description: '상태값 ex) 임시저장: DRAFT, 등록: REGISTER (기본값: REGISTER)',
    enum: IUserDriveStatus,
    default: IUserDriveStatus.REGISTER,
  })
  // =================================
  // 신규 문서는 이전 상태가 없어 "안 보냄" 의 해석이 하나뿐이다(= REGISTER). 그래서 선택이다.
  @IsOptional()
  @IsEnum(IUserDriveStatus)
  status?: IUserDriveStatus;
}

export class UserDriveUpdateReqDto extends UserDriveWriteBaseReqDto {
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
  // 수정 대상에는 이미 상태가 있어 "안 보냄" 이 "유지" 인지 "초기화" 인지 모호하다. PUT 은 전체 교체이고
  // 나머지 필드(receiverId/title/content)도 전부 필수라, status 만 예외를 두지 않고 명시를 요구한다.
  @IsNotEmpty()
  @IsEnum(IUserDriveStatus)
  status: IUserDriveStatus;
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
