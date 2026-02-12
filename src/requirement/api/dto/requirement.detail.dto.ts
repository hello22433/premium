import { RequirementType } from '../../interface/requirement.type';
import { RequirementStatus } from '../../interface/requirement.status';
import { RequirementPriority } from '../../interface/requirement.priority';
import { ApiProperty } from '@nestjs/swagger';

export class RequirementCommentDto {
  @ApiProperty({ description: '댓글 id' })
  id: number;

  @ApiProperty({ description: '작성자 user id' })
  userId: number;

  @ApiProperty({ description: '작성자명' })
  userName: string;

  @ApiProperty({ description: '댓글 내용' })
  content: string;

  @ApiProperty({ description: '작성일 ex) yyyy-MM-ddTHH:mm:ss' })
  createdAt: string;
}

export class RequirementAttachmentViewDto {
  @ApiProperty({ description: '첨부파일 id' })
  id: number;

  @ApiProperty({ description: '파일 URL' })
  fileUrl: string;

  @ApiProperty({ description: '파일명' })
  fileName: string;
}

export class RequirementDetailDto {
  @ApiProperty({ description: '요구사항 id' })
  id: number;

  @ApiProperty({ description: '작성자 user id' })
  userId: number;

  @ApiProperty({ description: '작성자명' })
  userName: string;

  @ApiProperty({ description: '제목' })
  title: string;

  @ApiProperty({ description: '유형 ex) NEW_FEATURE, MODIFICATION, BUG' })
  type: RequirementType;

  @ApiProperty({ description: '관련 페이지' })
  relatedPage: string | null;

  @ApiProperty({ description: '우선순위 ex) URGENT, HIGH, NORMAL' })
  priority: RequirementPriority;

  @ApiProperty({ description: '상세 내용' })
  content: string;

  @ApiProperty({ description: '상태 ex) NEW, REVIEW, IN_PROGRESS, COMPLETE' })
  status: RequirementStatus;

  @ApiProperty({ description: '등록일 ex) yyyy-MM-ddTHH:mm:ss' })
  createdAt: string;

  @ApiProperty({ description: '댓글 목록', type: [RequirementCommentDto] })
  comments: RequirementCommentDto[];

  @ApiProperty({ description: '첨부파일 목록', type: [RequirementAttachmentViewDto] })
  attachments: RequirementAttachmentViewDto[];
}
