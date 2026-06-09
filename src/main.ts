process.env.TZ = 'Asia/Seoul';

import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { TransformResInterceptor } from './common/api/transform.res.interceptor';
import { Logger, ValidationPipe } from '@nestjs/common';
import { initializeTransactionalContext } from 'typeorm-transactional';
import { DeliveryBatchService } from './delivery/application/delivery.batch.service';
import { PartnerCompanyExternHistoryService } from './partner_company_extern_history/application/partner.company.extern.history.service';

async function bootstrap() {
  initializeTransactionalContext();

  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableCors();
  app.useBodyParser('json', { limit: '50mb' });
  app.useBodyParser('urlencoded', { limit: '50mb', extended: true });
  app.useBodyParser('text', { type: ['application/xml', 'text/xml'], limit: '10mb' });
  app.set('trust proxy', true);
  app.useGlobalInterceptors(new TransformResInterceptor());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const config = new DocumentBuilder()
    .setTitle('epopkon-premium')
    .setDescription('epopkon API 문서')
    .setVersion('1.0')
    .addBearerAuth()
    .addApiKey({ type: 'apiKey', in: 'header', name: 'x-api-key' }, 'api-key')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
    },
  });

  // 부팅 stale claim 해제 — HTTP 서버 프로세스에서만, app.listen() 전에 수행한다.
  // (lifecycle 훅이 아닌 진입점에 둬서, scheduler 포함 standalone bootstrap 인 마이그레이션
  //  스크립트가 살아있는 HTTP 프로세스의 claim 을 해제하는 사고를 차단)
  // ⚠️ 배포는 pm2 restart 또는 stop-then-start 로 고정한다. pm2 reload(무중단)는 구·신
  //    프로세스가 잠시 겹쳐, 신 프로세스가 구 프로세스의 활성 FAIL claim 을 해제 → 중복 발송
  //    위험이 있으므로 금지한다.
  // WAIT/FAIL 복구는 각각 독립 처리한다. 복구 정책은 self-heal 유무로 다르다:
  //  - WAIT(배치): 5분 self-heal 이 없다(cron 은 claimedAt IS NULL 만 재claim). 해제 실패 시
  //    해당 행이 다음 재기동까지 정체되므로, 재시도 후에도 실패하면 기동을 중단(throw)해 pm2 가
  //    재시작하도록 한다.
  //  - FAIL(재발송): 5분 stale 재claim 이 최후 안전망이므로, 실패해도 로그만 남기고 기동 계속.
  const bootLogger = new Logger('Bootstrap');

  const WAIT_RELEASE_ATTEMPTS = 3;
  let waitReleased = false;
  for (let attempt = 1; attempt <= WAIT_RELEASE_ATTEMPTS; attempt++) {
    try {
      const released = await app.get(DeliveryBatchService).releaseStaleBatchClaims();
      if (released > 0) {
        bootLogger.warn(`[BOOT] WAIT 배치 stale 클레임 ${released}건 해제 (이전 프로세스 비정상 종료 흔적)`);
      }
      waitReleased = true;
      break;
    } catch (e) {
      bootLogger.error(`[BOOT] WAIT 배치 클레임 해제 실패 (시도 ${attempt}/${WAIT_RELEASE_ATTEMPTS})`, e);
      if (attempt < WAIT_RELEASE_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }
  if (!waitReleased) {
    // self-heal 이 없어 정체를 막기 위해 기동을 중단한다(→ 아래 bootstrap().catch 에서 process.exit → pm2 재시작).
    throw new Error('[BOOT] WAIT 배치 클레임 해제가 반복 실패 — 기동 중단');
  }

  try {
    const released = await app.get(PartnerCompanyExternHistoryService).releaseOrphanedResendClaims();
    if (released > 0) {
      bootLogger.warn(`[BOOT] FAIL 재발송 orphan 클레임 ${released}건 해제 (이전 프로세스 비정상 종료 흔적)`);
    }
  } catch (e) {
    bootLogger.error('[BOOT] FAIL 재발송 클레임 해제 실패 — 기동 계속 (5분 self-heal 으로 대체)', e);
  }

  let port = 3000;
  if (process.env.PORT) {
    port = +process.env.PORT;
  }
  await app.listen(port);
}

bootstrap().catch((e) => {
  // 부팅 단계 치명 오류(WAIT claim 해제 반복 실패 등) → 비정상 종료해 pm2 가 재시작하게 한다.
  new Logger('Bootstrap').error('[BOOT] 부팅 실패 — 프로세스 종료', e);
  process.exit(1);
});
