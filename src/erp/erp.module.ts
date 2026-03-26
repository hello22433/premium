import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ErpExternHttp } from './infra/erp.extern.http';
import { ErpProductService } from './application/erp.product.service';
import { ErpController } from './api/erp.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [HttpModule.register({ timeout: 30000 }), AuthModule],
  providers: [
    {
      provide: 'IErpExtern',
      useClass: ErpExternHttp,
    },
    ErpProductService,
  ],
  controllers: [ErpController],
  exports: [
    {
      provide: 'IErpExtern',
      useClass: ErpExternHttp,
    },
    ErpProductService,
  ],
})
export class ErpModule {}
