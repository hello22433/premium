import { Module } from '@nestjs/common';
import { FileService } from './application/file.service';
import { FileController } from './api/file.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [FileController],
  providers: [FileService],
})
export class FileModule {}
