import { Module } from '@nestjs/common';
import { BrandController } from './api/brand.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BrandEntity } from '../entity/brand.entity';
import { AuthModule } from '../auth/auth.module';
import { BrandService } from './application/brand.service';

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([BrandEntity])],
  controllers: [BrandController],
  providers: [BrandService],
})
export class BrandModule {}
