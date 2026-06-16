import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { HttpModule, HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { ErpExternHttp } from './infra/erp.extern.http';

// 수동 스모크 스크립트. 실 ecount OAPI 로 #42(Status 비교버그) 수정 검증. read-only.
// 실행: npx ts-node -r tsconfig-paths/register src/erp/erp.smoke.ts
// 주의: ecount API IP 화이트리스트에 실행 머신 IP 등록 필요. 미등록 IP 면 로그인 Code:"205" 로 실패.
//       그래서 자동 테스트(jest)·빌드(tsconfig.build.json)에서 제외한다.
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), HttpModule],
  providers: [ErpExternHttp],
})
class SmokeModule {}

async function main() {
  const ctx = await NestFactory.createApplicationContext(SmokeModule, {
    logger: ['error', 'warn'],
  });
  // --- 먼저 raw Zone 응답 덤프 ---
  const http = ctx.get(HttpService);
  const config = ctx.get(ConfigService);
  const comCode = config.getOrThrow('ERP_COM_CODE');
  const zoneResp = await firstValueFrom(http.post('https://oapi.ecount.com/OAPI/V2/Zone', { COM_CODE: comCode }, {}));
  console.log('=== ZONE RAW ===');
  console.log(JSON.stringify(zoneResp.data));

  const erp = ctx.get(ErpExternHttp);
  try {
    const res = await erp.getProductsList({ PROD_TYPE: '3' }); // 품목구분 3=상품
    console.log('=== RESULT ===');
    console.log('Status      =', res.Status, '(typeof', typeof res.Status + ')');
    console.log('Result count=', res.Data?.Result?.length);
    console.log('first PROD_CD=', res.Data?.Result?.[0]?.PROD_CD);
    console.log('OK: ecount 200 정상 응답 → #42 수정 검증');
  } catch (e) {
    console.error('=== CALL FAILED ===');
    console.error((e as Error).message);
  } finally {
    await ctx.close();
  }
}

void main();
