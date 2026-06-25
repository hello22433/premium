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
  // 물리 주소 필드 allowlist (소문자 exact match). includes 방식은 addressType 등 비PII 오탐 위험.
  private addressKeys = new Set([
    'businessaddress',
    'offlineaddress',
    'snapshotbusinessaddress',
    'snapshotclientbusinessaddress',
  ]);
  // 금융 브랜드/계좌 정보 allowlist (소문자 exact match). includes('bank'/'card')는 discard* 등 오탐 위험.
  private financialBrandKeys = new Set(['cardname', 'bankname', 'paymentbank', 'banknumber']);
  // base64 파일 등 대용량 페이로드 키 (소문자 exact match). 값 드롭 후 has* 플래그로 대체.
  private bulkDataKeys = new Set(['pdfbase64']);
  // 보고서 이메일 발송 경로. 수신자(to) 마스킹 및 HTML 본문(content) 드롭 적용.
  private reportEmailPaths = [
    '/order/delivery-complete/report/email',
    '/order/transaction-statement/report/email',
    '/order/destruction-certificate/report/email',
  ];
  // 일회용 인증코드(body.code)를 쓰는 경로. 'code'는 productCode 등과 충돌하므로 이 경로에서만 redact.
  private authCodePaths = ['/user-find/reset-password/verify', '/user/login/email/verify', '/user/login/phone/verify'];
  // URL 쿼리스트링에서 값 redact할 민감 파라미터(소문자). encryptKey/code 등은 링크로 외부 전달되나 로그 집적 방지.
  private sensitiveQueryParams = new Set(['encryptkey', 'sendencryptkey', 'code', 'token']);

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
   * - address: allowlist(addressKeys) exact match — includes 방식 오탐 방지.
   * - email: 키가 'email'로 끝날 때만(endsWith). 정규식으로 이메일 주소 추출 후 인플레이스 마스킹.
   *   패턴 없으면 undefined 반환(원문 보존). emailTitle 등 이메일 메타 필드 오탐 차단.
   */
  private maskByKey(key: string, value: unknown): string | undefined {
    if (typeof value !== 'string' || value.length === 0) return undefined;
    const lower = key.toLowerCase();

    if (this.nameKeyParts.some((p) => lower.includes(p))) return MaskingUtil.maskPersonName(value);
    if (lower.includes('encryptkey') || lower.includes('token')) return '***';
    if (this.financialBrandKeys.has(lower)) return MaskingUtil.maskBrandName(value);
    if (lower.includes('cardnumber')) return MaskingUtil.maskCardNumber(value);
    // 사업자등록번호 등 식별번호. 'business' 단독은 businessName(공개 상호) 과잉가림이라 조각 한정.
    if (lower.includes('businessnumber')) return MaskingUtil.maskBusinessNumber(value);
    if (this.addressKeys.has(lower)) return '***';
    if (lower.includes('phone') || lower.includes('mobile')) return MaskingUtil.maskPhoneNumber(value);
    if (lower === 'deliverytarget') return MaskingUtil.maskDeliveryTarget(value);
    if (lower.endsWith('email')) {
      const emailPattern = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
      const masked = value.replace(emailPattern, (m) => MaskingUtil.maskEmail(m));
      return masked === value ? undefined : masked;
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
   * - 비밀번호 계열: 환경 무관 항상 제거.
   * - 운영(ENVIRONMENT=prod): PII 추가 마스킹.
   * - 개발: 비밀번호 제거 외 마스킹 없이 평문 노출.
   */
  private sanitizeBody(body: any, originalUrl: string): any {
    const isReportEmail = this.reportEmailPaths.some((p) => originalUrl.includes(p));
    const prepared = this.prepareForLogging(body, isReportEmail);
    if (!this.isProd()) return prepared;
    const maskCode = this.authCodePaths.some((p) => originalUrl.includes(p));
    return this.maskSensitiveData(prepared, maskCode);
  }

  /**
   * 로깅 전 body 전처리 (환경 무관).
   * - 비밀번호/대용량 페이로드(pdfBase64): 값 제거 후 has* 플래그로 대체.
   * - 보고서 이메일 경로: HTML 본문(content) 드롭(볼륨 절감, env 무관), 수신자(to)는 운영에서만 마스킹(PII).
   */
  private prepareForLogging(body: any, isReportEmail = false): any {
    if (Array.isArray(body)) return body.map((item) => this.prepareForLogging(item, isReportEmail));
    if (!body || typeof body !== 'object') return body;
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(body)) {
      const lower = key.toLowerCase();
      const hasFlag = `has${key.charAt(0).toUpperCase() + key.slice(1)}`;
      if (this.passwordKeys.has(lower) || this.bulkDataKeys.has(lower)) {
        result[hasFlag] = true;
      } else if (isReportEmail && lower === 'content') {
        result[hasFlag] = true;
      } else if (isReportEmail && this.isProd() && lower === 'to' && typeof value === 'string' && value.includes('@')) {
        const emailPattern = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
        result[key] = value.replace(emailPattern, (m) => MaskingUtil.maskEmail(m));
      } else if (value && typeof value === 'object') {
        result[key] = this.prepareForLogging(value, isReportEmail);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  /**
   * URL 쿼리스트링의 민감 파라미터 값을 redact (운영 한정 호출).
   * 1) sensitiveQueryParams: encryptKey 등 capability 토큰 → 무조건 redact.
   * 2) maskByKey fallback: personName/personPhoneNumber/deliveryTarget 등 PII 필드 → 키 기반 마스킹.
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
        const decodedKey = this.decodeKey(k);
        if (this.sensitiveQueryParams.has(decodedKey)) return `${k}=***`;
        const rawVal = pair.slice(eq + 1);
        let decodedVal: string;
        try {
          decodedVal = decodeURIComponent(rawVal);
        } catch {
          decodedVal = rawVal;
        }
        const maskedVal = this.maskByKey(decodedKey, decodedVal);
        return maskedVal !== undefined ? `${k}=${maskedVal}` : pair;
      })
      .join('&');
    return `${path}?${masked}`;
  }

  /** path 세그먼트 중 이메일(@ 또는 %40 포함)은 redact. /user-biz/:bizNo 세그먼트도 redact. */
  private maskPathSegments(path: string): string {
    const segs = path.split('/');
    return segs
      .map((seg, i) => {
        if (seg.includes('@') || seg.toLowerCase().includes('%40')) return '***';
        if (i > 0 && segs[i - 1] === 'user-biz') return MaskingUtil.maskBusinessNumber(seg);
        return seg;
      })
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
