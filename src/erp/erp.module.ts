import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ErpExternHttp } from './infra/erp.extern.http';

@Module({
  imports: [HttpModule],
  providers: [
    {
      provide: 'IErpExtern',
      useClass: ErpExternHttp,
    },
  ],
  controllers: [],
  exports: [
    {
      provide: 'IErpExtern',
      useClass: ErpExternHttp,
    },
  ],
})
export class ErpModule {}
