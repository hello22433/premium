import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { QnaEntity } from '../entity/qna.entity';
import { UserEntity } from '../entity/user.entity';
import { QnaController } from './api/qna.controller';
import { QnaService } from './application/qna.service';

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([QnaEntity, UserEntity])],
  controllers: [QnaController],
  providers: [QnaService],
})
export class QnaModule {}
