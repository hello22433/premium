import { Type } from 'class-transformer';
import { PagingReqDto } from '../../common/api/dto/pagination.req.dto';
import { RequirementType } from '../interface/requirement.type';
import { RequirementStatus } from '../interface/requirement.status';
import { RequirementPriority } from '../interface/requirement.priority';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';

export class RequirementGetListReqQueryDto extends PagingReqDto {
  @ApiPropertyOptional({
    description: '상태 필터',
    enum: RequirementStatus,
  })
  // =================================
  @IsOptional()
  @IsIn(['NEW', 'REVIEW', 'IN_PROGRESS', 'COMPLETE'])
  status?: RequirementStatus;

  @ApiPropertyOptional({
    description: '유형 필터',
    enum: RequirementType,
  })
  // =================================
  @IsOptional()
  @IsIn(['NEW_FEATURE', 'MODIFICATION', 'BUG'])
  type?: RequirementType;

  @ApiPropertyOptional({
    description: '우선순위 필터',
    enum: RequirementPriority,
  })
  // =================================
  @IsOptional()
  @IsIn(['URGENT', 'HIGH', 'NORMAL'])
  priority?: RequirementPriority;
}

export class RequirementGetDetailReqParamDto {
  @ApiProperty({
    description: 'requirement id',
  })
  // =================================
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  id: number;
}

export class RequirementAttachmentDto {
  @ApiProperty({
    description: '파일 URL',
  })
  // =================================
  @IsNotEmpty()
  @IsString()
  fileUrl: string;

  @ApiProperty({
    description: '파일명',
  })
  // =================================
  @IsNotEmpty()
  @IsString()
  fileName: string;
}

export class RequirementCreateReqDto {
  @ApiProperty({
    description: '요구사항 제목',
  })
  // =================================
  @IsNotEmpty()
  @IsString()
  title: string;

  @ApiProperty({
    description: '유형 ex) NEW_FEATURE, MODIFICATION, BUG',
    enum: RequirementType,
  })
  // =================================
  @IsNotEmpty()
  @IsIn(['NEW_FEATURE', 'MODIFICATION', 'BUG'])
  type: RequirementType;

  @ApiPropertyOptional({
    description: '관련 페이지',
  })
  // =================================
  @IsOptional()
  @IsString()
  relatedPage?: string;

  @ApiProperty({
    description: '우선순위 ex) URGENT, HIGH, NORMAL',
    enum: RequirementPriority,
  })
  // =================================
  @IsNotEmpty()
  @IsIn(['URGENT', 'HIGH', 'NORMAL'])
  priority: RequirementPriority;

  @ApiProperty({
    description: '상세 내용',
  })
  // =================================
  @IsNotEmpty()
  @IsString()
  content: string;

  @ApiProperty({
    description: '첨부파일 목록',
    type: [RequirementAttachmentDto],
  })
  // =================================
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RequirementAttachmentDto)
  attachments: RequirementAttachmentDto[];
}

export class RequirementUpdateReqDto extends RequirementCreateReqDto {
  @ApiProperty({
    description: 'requirement id',
  })
  // =================================
  @IsNotEmpty()
  @IsNumber()
  id: number;
}

export class RequirementUpdateStatusReqDto {
  @ApiProperty({
    description: '변경할 상태',
    enum: RequirementStatus,
  })
  // =================================
  @IsNotEmpty()
  @IsIn(['NEW', 'REVIEW', 'IN_PROGRESS', 'COMPLETE'])
  status: RequirementStatus;
}

export class RequirementCommentCreateReqDto {
  @ApiProperty({
    description: '댓글 내용',
  })
  // =================================
  @IsNotEmpty()
  @IsString()
  content: string;
}

export class RequirementCommentDeleteReqParamDto {
  @ApiProperty({
    description: 'requirement id',
  })
  // =================================
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  id: number;

  @ApiProperty({
    description: 'comment id',
  })
  // =================================
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  commentId: number;
}
