import { Module } from '@nestjs/common';
import { UserBizService } from './application/user.biz.service';
import { UserBizController } from './api/user.biz.controller';
import { UserBizBiznoCrawling } from './infra/user.biz.bizno.crawling';

@Module({
  imports: [],
  controllers: [UserBizController],
  providers: [UserBizService, UserBizBiznoCrawling],
})
export class UserBizModule {}
