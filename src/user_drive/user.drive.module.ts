import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { UserDriveEntity } from '../entity/user.drive.entity';
import { UserEntity } from '../entity/user.entity';
import { UserDriveController } from './api/user.drive.controller';
import { UserDriveService } from './application/user.drive.service';
import { FileModule } from '../file/file.module';

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([UserDriveEntity, UserEntity]), FileModule],
  controllers: [UserDriveController],
  providers: [UserDriveService],
})
export class UserDriveModule {}
