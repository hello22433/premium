import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RequirementEntity } from '../../entity/requirement.entity';
import { RequirementCommentEntity } from '../../entity/requirement.comment.entity';
import { RequirementAttachmentEntity } from '../../entity/requirement.attachment.entity';
import {
  RequirementCommentCreateReqDto,
  RequirementCommentUpdateReqDto,
  RequirementCreateReqDto,
  RequirementGetDetailReqParamDto,
  RequirementGetListReqQueryDto,
  RequirementUpdateReqDto,
  RequirementUpdateStatusReqDto,
} from '../api/requirement.req.dto';
import { RequirementGetDetailResDto, RequirementGetListResDto } from '../api/requirement.res.dto';
import { RequirementViewDto } from '../api/dto/requirement.view.dto';
import { DateFormatStr } from '../../common/domain/date.format.str';
import { format } from 'date-fns';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { IUserAuthority } from '../../user/interface/user.authority';
import { RequirementStatus } from '../interface/requirement.status';
import { Response } from 'express';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { UserEntity } from '../../entity/user.entity';
import {
  REQUIREMENT_CHANGED_EVENT,
  RequirementEventAction,
  RequirementEventPayload,
} from '../interface/requirement.event';

@Injectable()
export class RequirementService {
  constructor(
    @InjectRepository(RequirementEntity)
    private requirementRepository: Repository<RequirementEntity>,
    @InjectRepository(RequirementCommentEntity)
    private commentRepository: Repository<RequirementCommentEntity>,
    @InjectRepository(RequirementAttachmentEntity)
    private attachmentRepository: Repository<RequirementAttachmentEntity>,
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
    private eventEmitter: EventEmitter2,
  ) {}

  async getList(getQuery: RequirementGetListReqQueryDto): Promise<RequirementGetListResDto> {
    const { take, page, status, type, priority, title, userName, startCreatedAt, endCreatedAt } = getQuery;

    let queryBuilder = this.requirementRepository
      .createQueryBuilder('requirement')
      .innerJoinAndSelect('requirement.user', 'user')
      .leftJoin('requirement.comments', 'comment', 'comment.deletedAt IS NULL')
      .leftJoin('requirement.attachments', 'attachment', 'attachment.deletedAt IS NULL')
      .addSelect('COUNT(DISTINCT comment.id)', 'commentCount')
      .addSelect('COUNT(DISTINCT attachment.id)', 'attachmentCount')
      .groupBy('requirement.id');

    if (status) {
      queryBuilder = queryBuilder.andWhere('requirement.status = :status', { status });
    }
    if (type) {
      queryBuilder = queryBuilder.andWhere('requirement.type = :type', { type });
    }
    if (priority) {
      queryBuilder = queryBuilder.andWhere('requirement.priority = :priority', { priority });
    }
    if (title) {
      queryBuilder = queryBuilder.andWhere('requirement.title LIKE :title', { title: `%${title}%` });
    }
    if (userName) {
      queryBuilder = queryBuilder.andWhere('user.personName LIKE :userName', { userName: `%${userName}%` });
    }
    if (startCreatedAt) {
      queryBuilder = queryBuilder.andWhere('requirement.createdAt >= :startCreatedAt', { startCreatedAt });
    }
    if (endCreatedAt) {
      queryBuilder = queryBuilder.andWhere('requirement.createdAt <= :endCreatedAt', { endCreatedAt });
    }

    const skip = (page - 1) * take;
    queryBuilder = queryBuilder.orderBy('requirement.id', 'DESC').offset(skip).limit(take);

    const rawResults = await queryBuilder.getRawAndEntities();
    let countQueryBuilder = this.requirementRepository
      .createQueryBuilder('requirement')
      .innerJoin('requirement.user', 'user');
    if (status) {
      countQueryBuilder = countQueryBuilder.andWhere('requirement.status = :status', { status });
    }
    if (type) {
      countQueryBuilder = countQueryBuilder.andWhere('requirement.type = :type', { type });
    }
    if (priority) {
      countQueryBuilder = countQueryBuilder.andWhere('requirement.priority = :priority', { priority });
    }
    if (title) {
      countQueryBuilder = countQueryBuilder.andWhere('requirement.title LIKE :title', { title: `%${title}%` });
    }
    if (userName) {
      countQueryBuilder = countQueryBuilder.andWhere('user.personName LIKE :userName', { userName: `%${userName}%` });
    }
    if (startCreatedAt) {
      countQueryBuilder = countQueryBuilder.andWhere('requirement.createdAt >= :startCreatedAt', { startCreatedAt });
    }
    if (endCreatedAt) {
      countQueryBuilder = countQueryBuilder.andWhere('requirement.createdAt <= :endCreatedAt', { endCreatedAt });
    }
    const totalCount = await countQueryBuilder.getCount();

    const totalPage = Math.ceil(totalCount / take);

    const resultList: RequirementViewDto[] = rawResults.entities.map((requirement, index) => {
      const raw = rawResults.raw[index];
      return {
        id: requirement.id,
        userId: requirement.userId,
        userName: requirement.user.personName,
        title: requirement.title,
        type: requirement.type,
        priority: requirement.priority,
        status: requirement.status,
        commentCount: Number(raw.commentCount) || 0,
        hasAttachment: (Number(raw.attachmentCount) || 0) > 0,
        createdAt: format(requirement.createdAt, DateFormatStr),
      };
    });

    return { list: resultList, totalCount, totalPage, currentPage: page };
  }

  async getDetail(getParam: RequirementGetDetailReqParamDto): Promise<RequirementGetDetailResDto> {
    const { id } = getParam;

    const requirement = await this.requirementRepository.findOne({
      where: { id },
      relations: ['user', 'comments', 'comments.user', 'attachments'],
    });

    if (!requirement) {
      throw new BadRequestException('요구사항이 존재하지 않습니다.');
    }

    return {
      id: requirement.id,
      userId: requirement.userId,
      userName: requirement.user.personName,
      title: requirement.title,
      type: requirement.type,
      relatedPage: requirement.relatedPage,
      priority: requirement.priority,
      content: requirement.content,
      status: requirement.status,
      createdAt: format(requirement.createdAt, DateFormatStr),
      comments: (requirement.comments || [])
        .filter((c: RequirementCommentEntity) => !c.deletedAt)
        .map((comment: RequirementCommentEntity) => ({
          id: comment.id,
          userId: comment.userId,
          userName: comment.user.personName,
          content: comment.content,
          createdAt: format(comment.createdAt, DateFormatStr),
        })),
      attachments: (requirement.attachments || [])
        .filter((a: RequirementAttachmentEntity) => !a.deletedAt)
        .map((attachment: RequirementAttachmentEntity) => ({
          id: attachment.id,
          fileUrl: attachment.fileUrl,
          fileName: attachment.fileName,
        })),
    };
  }

  async create(user: ILoginUserInfo, getBody: RequirementCreateReqDto) {
    const { title, type, relatedPage, priority, content, attachments } = getBody;

    const result = await this.requirementRepository.insert({
      userId: user.id,
      title,
      type,
      relatedPage: relatedPage || null,
      priority,
      content,
      status: RequirementStatus.NEW,
    });

    const requirementId = result.identifiers[0].id;

    if (attachments.length > 0) {
      await this.attachmentRepository.insert(
        attachments.map((att) => ({
          requirementId,
          fileUrl: att.fileUrl,
          fileName: att.fileName,
        })),
      );
    }

    await this.emitRequirementEvent(user, RequirementEventAction.CREATED, requirementId, title);
  }

  async update(user: ILoginUserInfo, getBody: RequirementUpdateReqDto) {
    const { id, title, type, relatedPage, priority, content, attachments } = getBody;

    const requirement = await this.requirementRepository.findOne({
      where: { id },
    });

    if (!requirement) {
      throw new BadRequestException('요구사항이 존재하지 않습니다.');
    }

    const isSuperAdmin = user.authority === IUserAuthority.SUPER_ADMIN;
    const isOwner = requirement.userId === user.id;

    if (!isSuperAdmin && !isOwner) {
      throw new ForbiddenException('수정 권한이 없습니다.');
    }

    requirement.title = title;
    requirement.type = type;
    requirement.relatedPage = relatedPage || null;
    requirement.priority = priority;
    requirement.content = content;
    await this.requirementRepository.save(requirement);

    // 기존 첨부파일 soft delete 후 새로 insert
    await this.attachmentRepository.softDelete({ requirementId: id });

    if (attachments.length > 0) {
      await this.attachmentRepository.insert(
        attachments.map((att) => ({
          requirementId: id,
          fileUrl: att.fileUrl,
          fileName: att.fileName,
        })),
      );
    }

    await this.emitRequirementEvent(user, RequirementEventAction.UPDATED, id, title);
  }

  async delete(user: ILoginUserInfo, id: number) {
    const requirement = await this.requirementRepository.findOne({
      where: { id },
    });

    if (!requirement) {
      throw new BadRequestException('요구사항이 존재하지 않습니다.');
    }

    const isSuperAdmin = user.authority === IUserAuthority.SUPER_ADMIN;
    const isOwner = requirement.userId === user.id;

    if (!isSuperAdmin && !isOwner) {
      throw new ForbiddenException('삭제 권한이 없습니다.');
    }

    await this.requirementRepository.softDelete(id);

    await this.emitRequirementEvent(user, RequirementEventAction.DELETED, id, requirement.title);
  }

  async updateStatus(user: ILoginUserInfo, id: number, getBody: RequirementUpdateStatusReqDto) {
    const requirement = await this.requirementRepository.findOne({
      where: { id },
    });

    if (!requirement) {
      throw new BadRequestException('요구사항이 존재하지 않습니다.');
    }

    const isSuperAdmin = user.authority === IUserAuthority.SUPER_ADMIN;
    const isOwner = requirement.userId === user.id;

    if (!isSuperAdmin && !isOwner) {
      throw new ForbiddenException('상태 변경 권한이 없습니다.');
    }

    requirement.status = getBody.status;
    await this.requirementRepository.save(requirement);

    await this.emitRequirementEvent(user, RequirementEventAction.STATUS_CHANGED, id, requirement.title, {
      newStatus: getBody.status,
    });
  }

  async addComment(user: ILoginUserInfo, id: number, getBody: RequirementCommentCreateReqDto) {
    const requirement = await this.requirementRepository.findOne({
      where: { id },
    });

    if (!requirement) {
      throw new BadRequestException('요구사항이 존재하지 않습니다.');
    }

    await this.commentRepository.insert({
      requirementId: id,
      userId: user.id,
      content: getBody.content,
    });

    await this.emitRequirementEvent(user, RequirementEventAction.COMMENT_ADDED, id, requirement.title);
  }

  async deleteComment(user: ILoginUserInfo, id: number, commentId: number) {
    const comment = await this.commentRepository.findOne({
      where: { id: commentId, requirementId: id },
    });

    if (!comment) {
      throw new BadRequestException('댓글이 존재하지 않습니다.');
    }

    const isSuperAdmin = user.authority === IUserAuthority.SUPER_ADMIN;
    const isOwner = comment.userId === user.id;

    if (!isSuperAdmin && !isOwner) {
      throw new ForbiddenException('삭제 권한이 없습니다.');
    }

    await this.commentRepository.softDelete(commentId);

    const requirement = await this.requirementRepository.findOne({ where: { id } });
    await this.emitRequirementEvent(user, RequirementEventAction.COMMENT_DELETED, id, requirement?.title || '');
  }

  async updateComment(user: ILoginUserInfo, id: number, commentId: number, getBody: RequirementCommentUpdateReqDto) {
    const comment = await this.commentRepository.findOne({
      where: { id: commentId, requirementId: id },
    });

    if (!comment) {
      throw new BadRequestException('댓글이 존재하지 않습니다.');
    }

    const isSuperAdmin = user.authority === IUserAuthority.SUPER_ADMIN;
    const isOwner = comment.userId === user.id;

    if (!isSuperAdmin && !isOwner) {
      throw new ForbiddenException('수정 권한이 없습니다.');
    }

    comment.content = getBody.content;
    await this.commentRepository.save(comment);
  }

  async downloadMarkdown(id: number, res: Response) {
    const requirement = await this.requirementRepository.findOne({
      where: { id },
      relations: ['user', 'comments', 'comments.user', 'attachments'],
    });

    if (!requirement) {
      throw new BadRequestException('요구사항이 존재하지 않습니다.');
    }

    const typeKo: Record<string, string> = {
      NEW_FEATURE: '신규기능',
      MODIFICATION: '수정',
      BUG: '버그',
    };

    const priorityKo: Record<string, string> = {
      URGENT: '긴급',
      HIGH: '높음',
      NORMAL: '보통',
    };

    const statusKo: Record<string, string> = {
      NEW: '신규',
      IN_PROGRESS: '진행중',
      REJECTED: '반려',
      DEV_COMPLETE: '개발완료',
      REVIEW_COMPLETE: '검토완료',
    };

    // HTML 태그 제거 (plain text 변환)
    const plainContent = requirement.content.replace(/<[^>]*>/g, '');

    let markdown = `# [REQ-${requirement.id}] ${requirement.title}\n\n`;
    markdown += `- 유형: ${typeKo[requirement.type] || requirement.type}\n`;
    if (requirement.relatedPage) {
      markdown += `- 관련 페이지: ${requirement.relatedPage}\n`;
    }
    markdown += `- 우선순위: ${priorityKo[requirement.priority] || requirement.priority}\n`;
    markdown += `- 작성자: ${requirement.user.personName}\n`;
    markdown += `- 작성일: ${format(requirement.createdAt, DateFormatStr)}\n`;
    markdown += `- 상태: ${statusKo[requirement.status] || requirement.status}\n`;
    markdown += `\n## 상세 내용\n${plainContent}\n`;

    const activeComments = (requirement.comments || []).filter((c: RequirementCommentEntity) => !c.deletedAt);
    if (activeComments.length > 0) {
      markdown += `\n## 답글\n`;
      activeComments.forEach((comment: RequirementCommentEntity) => {
        markdown += `- ${comment.user.personName} (${format(comment.createdAt, DateFormatStr)}): ${comment.content}\n`;
      });
    }

    const activeAttachments = (requirement.attachments || []).filter((a: RequirementAttachmentEntity) => !a.deletedAt);
    if (activeAttachments.length > 0) {
      markdown += `\n## 첨부\n`;
      activeAttachments.forEach((attachment: RequirementAttachmentEntity) => {
        markdown += `- ${attachment.fileName}\n`;
      });
    }

    const fileName = `REQ-${requirement.id}-${requirement.title.replace(/[^a-zA-Z0-9가-힣]/g, '_')}.md`;
    const encodedFileName = encodeURIComponent(fileName);

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodedFileName}`);
    res.send(markdown);
  }

  private async emitRequirementEvent(
    user: ILoginUserInfo,
    action: RequirementEventAction,
    requirementId: number,
    requirementTitle: string,
    metadata?: { newStatus?: string },
  ) {
    let actorName = user.email;
    const userEntity = await this.userRepository.findOne({ where: { id: user.id } });
    if (userEntity?.personName) {
      actorName = userEntity.personName;
    }

    const payload: RequirementEventPayload = {
      action,
      requirementId,
      requirementTitle,
      actorName,
      actorId: user.id,
      timestamp: new Date().toISOString(),
      ...(metadata ? { metadata } : {}),
    };

    this.eventEmitter.emit(REQUIREMENT_CHANGED_EVENT, payload);
  }
}
