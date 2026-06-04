import { LoggerMiddleware } from './logger.middleware';

/**
 * sanitizeBody(private)를 캐스팅으로 직접 호출해 마스킹 규칙을 고정한다.
 * 환경은 process.env.ENVIRONMENT로 분기되며 호출 시점에 읽힌다.
 */
describe('LoggerMiddleware 마스킹', () => {
  const mw = new LoggerMiddleware();
  const sanitize = (body: any, url = '/any/path') => (mw as any).sanitizeBody(body, url);

  const ORIGINAL_ENV = process.env.ENVIRONMENT;
  afterAll(() => {
    process.env.ENVIRONMENT = ORIGINAL_ENV;
  });

  describe('dev (ENVIRONMENT !== prod)', () => {
    beforeEach(() => {
      process.env.ENVIRONMENT = 'dev';
    });

    test('비번/PII 포함 전체를 평문 그대로 통과시킨다 (디버깅용)', () => {
      const body = { password: 'pw1234', personPhoneNumber: '01012345678', personEmail: 'hong@example.com' };
      expect(sanitize(body)).toEqual(body);
    });
  });

  describe('prod (ENVIRONMENT === prod)', () => {
    beforeEach(() => {
      process.env.ENVIRONMENT = 'prod';
    });

    test('비밀번호 계열은 값 제거 후 has* 플래그만 남긴다', () => {
      const r = sanitize({ password: 'pw', newPassword: 'np', confirmPassword: 'cp' });
      expect(r.password).toBeUndefined();
      expect(r.hasPassword).toBe(true);
      expect(r.hasNewPassword).toBe(true);
      expect(r.hasConfirmPassword).toBe(true);
    });

    test('전화번호 필드(person/business 접두사 포함)를 마스킹한다', () => {
      const r = sanitize({ personPhoneNumber: '01012345678', businessPhoneNumber: '01087654321' });
      expect(r.personPhoneNumber).toBe('010-****-5678');
      expect(r.businessPhoneNumber).toBe('010-****-4321');
    });

    test('이메일 필드(@ 있는 값)를 마스킹한다', () => {
      const r = sanitize({ personEmail: 'hong@example.com', newEmail: 'abc@test.com' });
      expect(r.personEmail).not.toBe('hong@example.com');
      expect(r.personEmail).toContain('@example.com');
      expect(r.newEmail).toContain('@test.com');
    });

    test('이메일 키지만 @ 없는 값은 ***로 redact한다 (빈문자열 소실 방지)', () => {
      const r = sanitize({ emailTitle: '가입을 축하합니다' });
      expect(r.emailTitle).toBe('***');
    });

    test('이름류(접두사 변형 포함)를 부분 마스킹한다', () => {
      const r = sanitize({ personName: '홍길동', userPersonName: '김철수', bankAccountOwner: '이영희' });
      expect(r.personName).toBe('홍**');
      expect(r.userPersonName).toBe('김**');
      expect(r.bankAccountOwner).toBe('이**');
    });

    test('토큰/은행 필드를 redact한다', () => {
      const r = sanitize({ accessToken: 'abc.def', encryptKey: 'deadbeef', bankNumber: '110-123-456' });
      expect(r.accessToken).toBe('***');
      expect(r.encryptKey).toBe('***');
      expect(r.bankNumber).toBe('***');
    });

    test('사업자등록번호는 redact, 상호(businessName)는 보존한다', () => {
      const r = sanitize({
        businessNumber: '123-45-67890',
        businessName: '이팝콘',
        businessPhoneNumber: '01012345678',
      });
      expect(r.businessNumber).toBe('***');
      expect(r.businessName).toBe('이팝콘');
      expect(r.businessPhoneNumber).toBe('010-****-5678');
    });

    test('비PII 필드는 오탐 없이 보존한다 (오탐 회귀 방지)', () => {
      const body = {
        productCode: 'PRD-001',
        companyName: '이팝콘',
        hotelName: '신라호텔',
        mailingAddress: '서울시',
        fileName: 'a.png',
      };
      expect(sanitize(body)).toEqual(body);
    });

    test('인증 code는 authCodePaths에서만 redact한다', () => {
      expect(sanitize({ code: '483920' }, '/user/login/email/verify').code).toBe('***');
      expect(sanitize({ code: '483920' }, '/user/login/phone/verify').code).toBe('***');
      expect(sanitize({ code: '483920' }, '/user-find/reset-password/verify').code).toBe('***');
    });

    test('인증 경로가 아니면 code(상품코드 등)는 보존한다', () => {
      expect(sanitize({ code: 'PRD-001' }, '/product/detail').code).toBe('PRD-001');
    });

    test('중첩 객체/배열을 재귀적으로 마스킹한다', () => {
      const r = sanitize({
        user: { personPhoneNumber: '01012345678' },
        list: [{ personEmail: 'a@b.com' }],
      });
      expect(r.user.personPhoneNumber).toBe('010-****-5678');
      expect(r.list[0].personEmail).not.toBe('a@b.com');
    });

    test('원본 body를 변형하지 않는다 (새 객체 반환)', () => {
      const body = { password: 'pw', personPhoneNumber: '01012345678' };
      sanitize(body);
      expect(body.password).toBe('pw');
      expect(body.personPhoneNumber).toBe('01012345678');
    });
  });

  describe('maskUrl (쿼리스트링 민감 파라미터)', () => {
    const maskUrl = (url: string) => (mw as any).maskUrl(url);

    test('쿼리 없는 URL은 그대로 둔다', () => {
      expect(maskUrl('/order/receive/email')).toBe('/order/receive/email');
    });

    test('encryptKey/code/token 값을 redact하고 일반 파라미터는 보존한다', () => {
      const out = maskUrl('/order/receive/email?encryptKey=deadbeef&code=483920&page=2');
      expect(out).toBe('/order/receive/email?encryptKey=***&code=***&page=2');
    });

    test('파라미터 키 대소문자 무관하게 redact한다', () => {
      expect(maskUrl('/x?EncryptKey=abc')).toBe('/x?EncryptKey=***');
    });

    test('경로(path)는 보존한다', () => {
      expect(maskUrl('/order/receive/email?token=abc')).toContain('/order/receive/email?');
    });

    test('path 세그먼트의 이메일(@)을 redact한다', () => {
      expect(maskUrl('/user/exist-email/hong@example.com')).toBe('/user/exist-email/***');
    });

    test('path 세그먼트의 percent-encoded 이메일(%40)도 redact한다', () => {
      expect(maskUrl('/user/exist-email/hong%40example.com')).toBe('/user/exist-email/***');
    });

    test('percent-encoding으로 키를 숨겨도 디코드 후 redact한다 (우회 차단)', () => {
      // encrypt%4Bey => encryptKey
      expect(maskUrl('/x?encrypt%4Bey=secret')).toBe('/x?encrypt%4Bey=***');
    });
  });
});
