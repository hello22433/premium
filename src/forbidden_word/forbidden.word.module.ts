import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { ForbiddenWordEntity } from '../entity/forbidden.word.entity';
import { ForbiddenWordHistoryEntity } from '../entity/forbidden.word.history.entity';
import { ForbiddenWordBlockLogEntity } from '../entity/forbidden.word.block.log.entity';
import { ForbiddenWordController } from './api/forbidden.word.controller';
import { ForbiddenWordService } from './application/forbidden.word.service';
import { ForbiddenWordMatcher } from './application/forbidden.word.matcher';

@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([
      ForbiddenWordEntity,
      ForbiddenWordHistoryEntity,
      ForbiddenWordBlockLogEntity,
    ]),
  ],
  controllers: [ForbiddenWordController],
  providers: [ForbiddenWordService, ForbiddenWordMatcher],
  exports: [ForbiddenWordMatcher],
})
export class ForbiddenWordModule {}
