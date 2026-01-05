import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EmailManualEntity } from '../entity/email.manual.entity';
import { UserEntity } from '../entity/user.entity';
import { EmailManualController } from './api/email.manual.controller';
import { EmailManualService } from './application/email.manual.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([EmailManualEntity, UserEntity])],
  controllers: [EmailManualController],
  providers: [EmailManualService],
  exports: [EmailManualService],
})
export class EmailManualModule {}
