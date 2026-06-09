import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm';

/**
 * AWS SSM Parameter Store의 비밀값을 읽어 process.env에 주입한다.
 * (ENVIRONMENT에서 경로를 자동 유도 — prod/dev/local 환경별 비밀 분리)
 *
 * 동작 한눈에:
 * - 게이트: ENVIRONMENT 가 지정돼 있으면 동작, 없으면 즉시 반환(기존 .env 그대로, 무영향).
 * - 환경별 경로: 접두를 ENVIRONMENT 값에서 자동 유도 → prod=/epopkon-premium/prod/,
 *     dev=/epopkon-premium/dev/, local=/epopkon-premium/local/ (env별 비밀 분리).
 *     SSM_PARAM_PATH 를 주면 그 값으로 override(스테이징 등 비표준 경로용).
 * - 출처만 교체: 값을 process.env에 채워두므로 기존 ConfigService.get()/process.env 코드 전부 무수정.
 * - 페일세이프: SSM 호출이 실패해도 throw 하지 않고 경고만 남기고 진행
 *   (전환기엔 .env에 비밀이 남아있어 자연 폴백 → 앱이 안 죽음).
 * - 기존 env 보존: 이미 process.env에 있는 키는 덮지 않음(부트스트랩 설정/명시적 오버라이드 우선).
 * - 값은 절대 로깅하지 않음(개수만).
 *
 * ⚠️ main.ts 의 NestFactory.create() "이전"에 호출해야 한다.
 *    (DatabaseModule 등 모듈이 설정을 읽기 전에 process.env가 채워져 있어야 하므로)
 */
export async function hydrateEnvFromSsm(): Promise<void> {
  // 게이트: ENVIRONMENT가 지정돼 있어야 동작. 미설정이면 무동작 → 기존 .env 그대로(무영향).
  const environment = process.env.ENVIRONMENT;
  if (!environment) return;

  const region = process.env.SSM_REGION ?? process.env.AWS_REGION ?? 'ap-northeast-2';
  // 접두는 환경 이름에서 자동 유도: prod→/prod, dev→/dev, local→/local.
  // SSM_PARAM_PATH 를 주면 그 값으로 명시 override(스테이징 등 비표준 경로용).
  const rawPrefix = process.env.SSM_PARAM_PATH ?? `/epopkon-premium/${environment}/`;
  // 끝 슬래시 보장: 아래 slice(prefix.length)가 접두를 정확히 떼려면 '/'로 끝나야 함
  // (override로 끝 슬래시 없이 들어와도 키 이름 앞에 '/'가 붙는 것을 방지).
  const prefix = rawPrefix.endsWith('/') ? rawPrefix : `${rawPrefix}/`;

  try {
    const client = new SSMClient({ region });
    let nextToken: string | undefined;
    let loaded = 0;

    // GetParametersByPath 는 한 번에 최대 10개 → NextToken 으로 페이지네이션.
    do {
      const res = await client.send(
        new GetParametersByPathCommand({
          Path: prefix,
          Recursive: true,
          WithDecryption: true, // SecureString 복호화
          MaxResults: 10,
          NextToken: nextToken,
        }),
      );

      for (const p of res.Parameters ?? []) {
        if (!p.Name || p.Value === undefined) continue;
        // '/epopkon-premium/prod/DATABASE_PASSWORD' → 'DATABASE_PASSWORD'
        const key = p.Name.slice(prefix.length);
        if (key && process.env[key] === undefined) {
          process.env[key] = p.Value;
          loaded += 1;
        }
      }
      nextToken = res.NextToken;
    } while (nextToken);

    // 값은 절대 찍지 않는다 — 개수만.
    console.log(`[SSM] loaded ${loaded} parameter(s) from ${prefix}`);
  } catch (err) {
    // 페일세이프: 금고를 못 읽어도 앱은 계속 뜬다(전환기 .env 폴백).
    console.warn(
      `[SSM] failed to load parameters from ${prefix} (region=${region}). ` +
        `Falling back to existing environment. Reason: ${(err as Error).message}`,
    );
  }
}
