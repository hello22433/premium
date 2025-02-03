import { Module } from '@nestjs/common';
import { MessageArchiveController } from './api/message.archive.controller';
import { MessageArchiveService } from './application/message.archive.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MessageArchiveEntity } from '../entity/message.archive.entity';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([MessageArchiveEntity])],
  controllers: [MessageArchiveController],
  providers: [MessageArchiveService],
})
export class MessageArchiveModule {}
