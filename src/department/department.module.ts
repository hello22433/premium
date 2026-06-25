import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { DepartmentController } from './api/department.controller';
import { DepartmentService } from './application/department.service';
import { DepartmentEntity } from '../entity/department.entity';
import { UserViewScopeEntity } from '../entity/user.view.scope.entity';
import { UserEntity } from '../entity/user.entity';

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([DepartmentEntity, UserViewScopeEntity, UserEntity])],
  controllers: [DepartmentController],
  providers: [DepartmentService],
  exports: [DepartmentService],
})
export class DepartmentModule {}
