import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InquiryEntity } from '../entity/inquiry.entity';
import { AuthModule } from '../auth/auth.module';
import { InquiryController } from './api/inquiry.controller';
import { InquiryService } from './application/inquiry.service';

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([InquiryEntity])],
  controllers: [InquiryController],
  providers: [InquiryService],
})
export class InquiryModule {}
