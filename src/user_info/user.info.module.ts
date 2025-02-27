import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity } from '../entity/user.entity';
import { UserInfoController } from './api/user.info.controller';
import { UserInfoService } from './application/user.info.service';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([UserEntity])],
  controllers: [UserInfoController],
  providers: [UserInfoService],
})
export class UserInfoModule {}
