import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NoticeEntity } from '../entity/notice.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NoticeService } from './application/notice.service';
import { NoticeController } from './api/notice.controller';

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([NoticeEntity])],
  controllers: [NoticeController],
  providers: [NoticeService],
})
export class NoticeModule {}
