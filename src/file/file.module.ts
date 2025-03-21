import { Module } from '@nestjs/common';
import { FileService } from './application/file.service';
import { FileController } from './api/file.controller';
import { AuthModule } from '../auth/auth.module';
import { FileStorageS3 } from './infra/file.storage.s3';

@Module({
  imports: [AuthModule],
  controllers: [FileController],
  providers: [
    FileService,
    {
      provide: 'IFileStorage',
      useClass: FileStorageS3,
    },
  ],
  exports: [
    FileService,
    {
      provide: 'IFileStorage',
      useClass: FileStorageS3,
    },
  ],
})
export class FileModule {}
