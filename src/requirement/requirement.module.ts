import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RequirementEntity } from '../entity/requirement.entity';
import { RequirementCommentEntity } from '../entity/requirement.comment.entity';
import { RequirementAttachmentEntity } from '../entity/requirement.attachment.entity';
import { UserEntity } from '../entity/user.entity';
import { RequirementService } from './application/requirement.service';
import { RequirementController } from './api/requirement.controller';

@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([RequirementEntity, RequirementCommentEntity, RequirementAttachmentEntity, UserEntity]),
  ],
  controllers: [RequirementController],
  providers: [RequirementService],
})
export class RequirementModule {}
