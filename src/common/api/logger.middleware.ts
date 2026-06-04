import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { MaskingUtil } from '../utils/masking.util';

@Injectable()
export class LoggerMiddleware implements NestMiddleware {
  private logger = new Logger('HTTP', { timestamp: true });

  private blacklist: string[] = [];

  // 비밀번호 계열: 값 제거 후 입력 여부(has*)만 기록 (소문자 exact match).
  private passwordKeys = new Set(['password', 'newpassword', 'oldpassword', 'confirmpassword']);
  // 이름류: 'name' 단독 substring은 companyName/productName/fileName 등 광범위 오탐 → 2단어 합성어 조각만.
  // (userPersonName/bankAccountOwner 등 접두사 변형까지 substring으로 포착, 오탐은 없음)
  private nameKeyParts = ['personname', 'receivername', 'recipientname', 'sendername', 'accountowner'];
  // 일회용 인증코드(body.code)를 쓰는 경로. 'code'는 productCode 등과 충돌하므로 이 경로에서만 redact.
  private authCodePaths = ['/user-find/reset-password/verify', '/user/login/email/verify', '/user/login/phone/verify'];
  // URL 쿼리스트링에서 값 redact할 민감 파라미터(소문자). encryptKey/code 등은 링크로 외부 전달되나 로그 집적 방지.
  private sensitiveQueryParams = new Set(['encryptkey', 'sendencryptkey', 'code', 'token', 'email']);

  private except(originalUrl: string) {
    return this.blacklist.includes(originalUrl);
    // return false 개발시 전체 로그 보기
  }

  private isProd(): boolean {
    return process.env.ENVIRONMENT === 'prod';
  }

  /**
   * 키 이름 기반 PII 마스킹. 마스킹 대상이 아니면 undefined 반환.
   * - name류: 'name' 단독은 광범위 오탐 → 'personname' 등 2단어 합성어 조각 substring만.
   * - phone/email/token/bank: 충돌 적은 substring 매칭(소문자). 'tel'/'mail' 같은 짧은 조각은
   *   제외('phone'이 telephone, 'email'이 *Email을 이미 커버) → hotel/mailingAddress 오탐 차단.
   * - address: ip/mac 제외(기술적 식별자) 후 물리 주소 전부 redact.
   * - email: 정규식으로 이메일 패턴 추출 후 인플레이스 마스킹. 패턴 없으면 마스킹 안 함.
   */
  private maskByKey(key: string, value: unknown): string | undefined {
    if (typeof value !== 'string' || value.length === 0) return undefined;
    const lower = key.toLowerCase();

    if (this.nameKeyParts.some((p) => lower.includes(p))) return MaskingUtil.maskPersonName(value);
    if (lower.includes('encryptkey') || lower.includes('token')) return '***';
    if (lower.includes('cardname') || lower.includes('bankname')) return MaskingUtil.maskBrandName(value);
    if (lower.includes('cardnumber')) return MaskingUtil.maskCardNumber(value);
    if (lower.includes('bank') || lower.includes('card')) return '***';
    // 사업자등록번호 등 식별번호. 'business' 단독은 businessName(공개 상호) 과잉가림이라 조각 한정.
    if (lower.includes('businessnumber')) return MaskingUtil.maskBusinessNumber(value);
    if (lower.includes('address') && !lower.includes('ip') && !lower.includes('mac')) return '***';
    if (lower.includes('phone') || lower.includes('mobile')) return MaskingUtil.maskPhoneNumber(value);
    if (lower === 'deliverytarget') return MaskingUtil.maskDeliveryTarget(value);
    if (lower.includes('email')) {
      const emailPattern = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
      return emailPattern.test(value) ? value.replace(emailPattern, (m) => MaskingUtil.maskEmail(m)) : undefined;
    }
    return undefined;
  }

  /**
   * body 재귀 정제 (운영 한정 호출).
   * - 비밀번호 계열: 값 제거하고 입력 여부(has*)만 기록.
   * - PII(전화/이메일/토큰/이름): 마스킹.
   */
  private maskSensitiveData(body: any, maskCode: boolean): any {
    if (Array.isArray(body)) {
      return body.map((item) => this.maskSensitiveData(item, maskCode));
    }
    if (!body || typeof body !== 'object') {
      return body;
    }

    const sanitized: Record<string, any> = {};

    for (const [key, value] of Object.entries(body)) {
      const lower = key.toLowerCase();

      // 비밀번호 계열: 값 제거하고 입력 여부만 기록
      if (this.passwordKeys.has(lower)) {
        const hasField = `has${key.charAt(0).toUpperCase() + key.slice(1)}`;
        sanitized[hasField] = true;
        continue;
      }

      // 일회용 인증코드: 해당 경로(authCodePaths)에서만 redact (productCode 등 비민감 code는 보존)
      if (maskCode && lower === 'code' && typeof value === 'string') {
        sanitized[key] = '***';
        continue;
      }

      // 키 기반 PII 마스킹
      const masked = this.maskByKey(key, value);
      if (masked !== undefined) {
        sanitized[key] = masked;
        continue;
      }

      // 중첩 객체/배열 재귀
      if (value && typeof value === 'object') {
        sanitized[key] = this.maskSensitiveData(value, maskCode);
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  /**
   * 환경별 body 정제.
   * - 운영(ENVIRONMENT=prod): 비밀번호/PII 마스킹.
   * - 개발: 디버깅을 위해 마스킹 없이 평문 노출.
   */
  private sanitizeBody(body: any, originalUrl: string): any {
    if (!this.isProd()) return body;
    const maskCode = this.authCodePaths.some((p) => originalUrl.includes(p));
    return this.maskSensitiveData(body, maskCode);
  }

  /**
   * URL 쿼리스트링의 민감 파라미터 값을 redact (운영 한정 호출).
   * encryptKey 등은 링크로 외부 전달되는 capability 토큰이나, 로그 집적 시 일괄 유출 방지.
   */
  private maskUrl(originalUrl: string): string {
    const q = originalUrl.indexOf('?');
    const path = this.maskPathSegments(q === -1 ? originalUrl : originalUrl.slice(0, q));
    if (q === -1) return path;
    const masked = originalUrl
      .slice(q + 1)
      .split('&')
      .map((pair) => {
        const eq = pair.indexOf('=');
        if (eq === -1) return pair;
        const k = pair.slice(0, eq);
        return this.sensitiveQueryParams.has(this.decodeKey(k)) ? `${k}=***` : pair;
      })
      .join('&');
    return `${path}?${masked}`;
  }

  /** path 세그먼트 중 이메일(@ 또는 %40 포함)은 redact. 이메일은 명확 신호라 ID 오탐 없음. */
  private maskPathSegments(path: string): string {
    return path
      .split('/')
      .map((seg) => (seg.includes('@') || seg.toLowerCase().includes('%40') ? '***' : seg))
      .join('/');
  }

  /** percent-encoding 우회 방지: 쿼리 키를 디코드 후 소문자로 비교. */
  private decodeKey(k: string): string {
    try {
      return decodeURIComponent(k).toLowerCase();
    } catch {
      return k.toLowerCase();
    }
  }

  use(req: Request, res: Response, next: NextFunction) {
    const { ip, method, originalUrl, body } = req;
    const userAgent = req.get('user-agent') || '';
    const now = Date.now();

    res.on('finish', () => {
      const {
        statusCode,
        locals: { errorCode },
      } = res;

      const newBody = this.except(originalUrl) ? {} : this.sanitizeBody(body, originalUrl);
      const loggedUrl = this.isProd() ? this.maskUrl(originalUrl) : originalUrl;

      let message = `${method} ${loggedUrl} ${ip} ${userAgent} ${statusCode} ${JSON.stringify(newBody)} ${Date.now() - now}ms`;
      message = errorCode ? message + ` ${errorCode}` : message;

      this.logger.log(message);
    });
    next();
  }
}
