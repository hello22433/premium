import { Module } from '@nestjs/common';
import { UserTaskHistoryController } from './api/user.task.history.controller';
import { UserTaskHistoryService } from './application/user.task.history.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity } from '../entity/user.entity';
import { UserTaskHistoryEntity } from '../entity/user.task.history.entity';
import { OrderEntity } from '../entity/order.entity';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([UserTaskHistoryEntity, UserEntity, OrderEntity])],
  controllers: [UserTaskHistoryController],
  providers: [UserTaskHistoryService],
})
export class UserTaskHistoryModule {}
