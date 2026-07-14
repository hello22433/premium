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
import { hydrateEnvFromSsm } from './config/hydrate-env-from-ssm';

/**
 * X-Forwarded-For 신뢰 범위 파싱. req.ip 가 위조 불가한 실제 클라이언트 IP를 반환하도록 프록시 신뢰 범위를 정한다.
 * - 미설정: 1 (프록시 1홉 신뢰 = 단일 리버스프록시 뒤 표준 배포에서 클라이언트 위조 불가).
 *   ⚠ 프록시가 2홉 이상(예: ALB+nginx)이면 TRUST_PROXY 에 실제 홉 수를 지정해야 정확한 클라이언트 IP가 잡힌다.
 * - 정수: 신뢰할 프록시 hop 수
 * - 'true'/'false': 불리언 (true=모든 프록시 신뢰 — leftmost XFF, 위조 가능하므로 지양)
 * - 그 외: subnet/IP 목록 (예: 'loopback, 10.0.0.0/8')
 */
function resolveTrustProxy(value?: string): boolean | number | string {
  if (value === undefined || value.trim() === '') {
    // 안전 기본값: 모든 프록시(true)를 신뢰하지 않고 1홉만 신뢰한다(XFF 선점 위조 방지).
    return 1;
  }
  const trimmed = value.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  const num = Number(trimmed);
  if (Number.isInteger(num) && num >= 0) return num;
  return trimmed;
}

async function bootstrap() {
  // SSM Parameter Store의 비밀값을 process.env에 주입한다.
  // 접두는 ENVIRONMENT에서 자동 유도(prod→/prod, dev→/dev, local→/local). ENVIRONMENT 미설정이면 .env 그대로.
  // NestFactory.create 이전 호출 필수(모듈이 설정을 읽기 전에 env가 채워져야 함).
  await hydrateEnvFromSsm();

  initializeTransactionalContext();

  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableCors();
  app.useBodyParser('json', { limit: '50mb' });
  app.useBodyParser('urlencoded', { limit: '50mb', extended: true });
  app.useBodyParser('text', { type: ['application/xml', 'text/xml'], limit: '10mb' });
  app.set('trust proxy', resolveTrustProxy(process.env.TRUST_PROXY));
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
