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

    test('비밀번호 계열은 dev에서도 제거하고 has* 플래그로 대체한다', () => {
      const r = sanitize({ password: 'pw1234', personPhoneNumber: '01012345678' });
      expect(r.password).toBeUndefined();
      expect(r.hasPassword).toBe(true);
      expect(r.personPhoneNumber).toBe('01012345678'); // PII는 dev에서 평문 유지
    });

    test('중첩 객체 안의 비밀번호도 dev에서 제거한다', () => {
      const r = sanitize({ user: { password: 'pw', name: '홍길동' } });
      expect(r.user.password).toBeUndefined();
      expect(r.user.hasPassword).toBe(true);
      expect(r.user.name).toBe('홍길동');
    });
  });

  describe('prod (ENVIRONMENT === prod)', () => {
    beforeEach(() => {
      process.env.ENVIRONMENT = 'prod';
    });

    test('비밀번호 계열은 값 제거 후 has* 플래그만 남긴다', () => {
      const r = sanitize({ password: 'pw', newPassword: 'np', oldPassword: 'op', confirmPassword: 'cp' });
      expect(r.password).toBeUndefined();
      expect(r.hasPassword).toBe(true);
      expect(r.hasNewPassword).toBe(true);
      expect(r.hasOldPassword).toBe(true);
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

    test('email로 끝나는 키라도 @ 없으면 원문 보존한다', () => {
      const r = sanitize({ userEmail: '이메일아님' });
      expect(r.userEmail).toBe('이메일아님');
    });

    test('이름류(접두사 변형 포함)를 부분 마스킹한다', () => {
      const r = sanitize({ personName: '홍길동', userPersonName: '김철수', bankAccountOwner: '이영희' });
      expect(r.personName).toBe('홍**');
      expect(r.userPersonName).toBe('김**');
      expect(r.bankAccountOwner).toBe('이**');
    });

    test('주소 allowlist 필드를 redact한다', () => {
      const r = sanitize({
        businessAddress: '서울시 강남구',
        offlineAddress: '서울시 서초구',
        snapshotBusinessAddress: '서울시 종로구',
        snapshotClientBusinessAddress: '서울시 마포구',
      });
      expect(r.businessAddress).toBe('***');
      expect(r.offlineAddress).toBe('***');
      expect(r.snapshotBusinessAddress).toBe('***');
      expect(r.snapshotClientBusinessAddress).toBe('***');
    });

    test('allowlist 외 address 계열 필드는 보존한다 (오탐 방지)', () => {
      const r = sanitize({ homeAddress: '서울시 강남구', mailingAddress: '서울시', addressType: 'HOME' });
      expect(r.homeAddress).toBe('서울시 강남구');
      expect(r.mailingAddress).toBe('서울시');
      expect(r.addressType).toBe('HOME');
    });

    test('카드번호를 부분 마스킹한다', () => {
      const r = sanitize({ cardNumber: '1234-5678-9012-3456' });
      expect(r.cardNumber).toBe('1234-****-****-3456');
    });

    test('deliveryTarget(전화번호)을 마스킹한다', () => {
      const r = sanitize({ deliveryTarget: '01012345678' });
      expect(r.deliveryTarget).toBe('010-****-5678');
    });

    test('deliveryTarget(이메일)을 마스킹한다', () => {
      const r = sanitize({ deliveryTarget: 'hong@example.com' });
      expect(r.deliveryTarget).not.toBe('hong@example.com');
      expect(r.deliveryTarget).toContain('@example.com');
    });

    test('mobile 접두사 전화번호를 마스킹한다', () => {
      const r = sanitize({ mobileNumber: '01012345678' });
      expect(r.mobileNumber).toBe('010-****-5678');
    });

    test('토큰/은행 필드를 redact한다', () => {
      const r = sanitize({ accessToken: 'abc.def', encryptKey: 'deadbeef', bankNumber: '110-123-456' });
      expect(r.accessToken).toBe('***');
      expect(r.encryptKey).toBe('***');
      expect(r.bankNumber).toBe('*********56');
    });

    test('카드명/은행명 필드를 브랜드 마스킹한다', () => {
      const r = sanitize({ cardName: '신한카드', bankName: '국민은행' });
      expect(r.cardName).not.toBe('신한카드');
      expect(r.bankName).not.toBe('국민은행');
    });

    test('사업자등록번호는 redact, 상호(businessName)는 보존한다', () => {
      const r = sanitize({
        businessNumber: '123-45-67890',
        businessName: '이팝콘',
        businessPhoneNumber: '01012345678',
      });
      expect(r.businessNumber).toBe('123-45-*****');
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
        emailTitle: '가입을 축하합니다',
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

  describe('보고서 이메일 경로 처리', () => {
    const REPORT_URL = '/order/delivery-complete/report/email';
    const OTHER_URL = '/order/detail';

    test('pdfBase64는 환경 무관하게 hasPdfBase64: true로 대체한다 (dev)', () => {
      process.env.ENVIRONMENT = 'dev';
      const r = sanitize({ pdfBase64: 'JVBERi0x...', pdfFileName: 'report.pdf' }, REPORT_URL);
      expect(r.pdfBase64).toBeUndefined();
      expect(r.hasPdfBase64).toBe(true);
      expect(r.pdfFileName).toBe('report.pdf');
    });

    test('pdfBase64는 환경 무관하게 hasPdfBase64: true로 대체한다 (prod)', () => {
      process.env.ENVIRONMENT = 'prod';
      const r = sanitize({ pdfBase64: 'JVBERi0x...', pdfFileName: 'report.pdf' }, REPORT_URL);
      expect(r.pdfBase64).toBeUndefined();
      expect(r.hasPdfBase64).toBe(true);
      expect(r.pdfFileName).toBe('report.pdf');
    });

    test('보고서 경로에서 content를 hasContent: true로 대체한다', () => {
      process.env.ENVIRONMENT = 'prod';
      const r = sanitize({ content: '<html>...</html>', subject: '발송완료 리포트' }, REPORT_URL);
      expect(r.content).toBeUndefined();
      expect(r.hasContent).toBe(true);
      expect(r.subject).toBe('발송완료 리포트');
    });

    test('보고서 경로에서 to 이메일을 마스킹한다 (prod)', () => {
      process.env.ENVIRONMENT = 'prod';
      const r = sanitize({ to: 'client@company.com', subject: '발송완료 리포트' }, REPORT_URL);
      expect(r.to).not.toBe('client@company.com');
      expect(r.to).toContain('@company.com');
    });

    test('보고서 경로라도 dev에서는 to를 평문 보존한다 (content/pdf는 드롭)', () => {
      process.env.ENVIRONMENT = 'dev';
      const r = sanitize({ to: 'client@company.com', content: '<html/>', pdfBase64: 'abc=' }, REPORT_URL);
      expect(r.to).toBe('client@company.com'); // PII는 dev 평문 철학 유지
      expect(r.hasContent).toBe(true); // 볼륨 절감은 env 무관
      expect(r.hasPdfBase64).toBe(true);
    });

    test('보고서 경로에서 to에 콤마 구분 여러 수신자가 있어도 각각 마스킹한다', () => {
      process.env.ENVIRONMENT = 'prod';
      const r = sanitize({ to: 'client@company.com, boss@other.com' }, REPORT_URL);
      expect(r.to).not.toContain('client');
      expect(r.to).not.toContain('boss');
      expect(r.to).toContain('@company.com');
      expect(r.to).toContain('@other.com');
    });

    test('보고서 경로 외에서는 content를 보존한다', () => {
      process.env.ENVIRONMENT = 'prod';
      const r = sanitize({ content: '공지사항 내용입니다.' }, OTHER_URL);
      expect(r.content).toBe('공지사항 내용입니다.');
    });

    test('보고서 경로 외에서는 to를 보존한다', () => {
      process.env.ENVIRONMENT = 'prod';
      const r = sanitize({ to: 'client@company.com' }, OTHER_URL);
      expect(r.to).toBe('client@company.com');
    });

    test('파기확약서 이메일 경로에서도 동일하게 적용된다', () => {
      process.env.ENVIRONMENT = 'prod';
      const r = sanitize(
        { to: 'a@b.com', content: '<html/>', pdfBase64: 'abc=', pdfFileName: 'cert.pdf' },
        '/order/destruction-certificate/report/email',
      );
      expect(r.hasPdfBase64).toBe(true);
      expect(r.hasContent).toBe(true);
      expect(r.to).not.toBe('a@b.com');
      expect(r.pdfFileName).toBe('cert.pdf');
    });

    test('거래명세서 이메일 경로에서 to 마스킹·content 드롭한다 (prod)', () => {
      process.env.ENVIRONMENT = 'prod';
      const r = sanitize(
        { to: 'client@company.com', content: '<html>pii</html>', subject: '거래명세서' },
        '/order/transaction-statement/report/email',
      );
      expect(r.content).toBeUndefined();
      expect(r.hasContent).toBe(true);
      expect(r.to).not.toBe('client@company.com');
      expect(r.to).toContain('@company.com');
      expect(r.subject).toBe('거래명세서');
    });
  });

  // ★ 쿼리만 가리면 다운로드 GET 만 닫힌다. 등록/수정 본문에도 같은 S3 URL 이 실려 오므로
  //   (private/{업로더id}/{uuid}-{원본명}) 본문 쪽도 같이 가려야 절반짜리 방어가 안 된다.
  /**
   * ★ res.on('finish') 안에서 던지면 ExceptionFilter 가 못 잡는다 — 응답이 이미 끝나 Node 의 emit()
   *   위에서 터지므로 uncaughtException 이 되고, 저장소에 그 핸들러가 없어 워커가 죽는다.
   *   요청자는 정상 응답을 받고, 죽는 건 그때 처리 중이던 '다른' 요청들이다.
   */
  describe('접근 로그 핸들러 방어', () => {
    const makeRes = () => {
      const handlers: Record<string, () => void> = {};
      return {
        res: {
          on: (ev: string, cb: () => void) => {
            handlers[ev] = cb;
          },
          statusCode: 200,
          locals: {},
        } as any,
        finish: () => handlers['finish'](),
      };
    };
    const req = (body: any) =>
      ({ ip: '1.1.1.1', method: 'POST', originalUrl: '/user-drive', body, get: () => '' }) as any;

    it('로그 생성이 던져도 예외가 밖으로 나가지 않는다 (프로세스 보호)', () => {
      const { res, finish } = makeRes();
      // 아주 깊은 중첩 body → sanitizeBody 재귀가 RangeError 를 낸다
      let deep: any = {};
      const root = deep;
      for (let i = 0; i < 60000; i++) deep = deep.a = {};
      mw.use(req(root), res, () => undefined);
      expect(() => finish()).not.toThrow();
    });

    it('삼키되 조용하지 않다 — 경고를 남긴다', () => {
      const warn = jest.spyOn((mw as any).logger, 'warn').mockImplementation(() => undefined);
      const { res, finish } = makeRes();
      let deep: any = {};
      const root = deep;
      for (let i = 0; i < 60000; i++) deep = deep.a = {};
      mw.use(req(root), res, () => undefined);
      finish();
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });

    // ★ 폴백 경로가 URL 을 원문으로 남기면, 정상 경로에서 가리는 값이 '실패했을 때만' 평문으로 샌다.
    //   보호 수준은 가장 약한 채널이 정한다 — 실패 경로도 같은 마스킹을 지나야 한다.
    it('로그 생성 실패 시에도 URL 의 민감 파라미터를 가린다', () => {
      const warn = jest.spyOn((mw as any).logger, 'warn').mockImplementation(() => undefined);
      const { res, finish } = makeRes();
      let deep: any = {};
      const root = deep;
      for (let i = 0; i < 60000; i++) deep = deep.a = {};
      const url =
        '/user-drive/1/file/download?fileUrl=https://b.s3.amazonaws.com/private/5/abc-해지신청서.pdf&token=secret123';
      mw.use({ ...req(root), originalUrl: url } as any, res, () => undefined);
      finish();

      const logged = String(warn.mock.calls[0][0]);
      expect(logged).not.toContain('private/5');
      expect(logged).not.toContain('해지신청서');
      expect(logged).not.toContain('secret123');
      expect(logged).toContain('/user-drive/1/file/download'); // 경로는 남아야 추적이 된다
      warn.mockRestore();
    });

    it('정상 body 는 기존대로 로그된다', () => {
      const log = jest.spyOn((mw as any).logger, 'log').mockImplementation(() => undefined);
      const { res, finish } = makeRes();
      mw.use(req({ title: 't' }), res, () => undefined);
      finish();
      expect(log).toHaveBeenCalledTimes(1);
      log.mockRestore();
    });
  });

  describe('본문의 첨부 URL 마스킹', () => {
    const attach = 'https://b.s3.amazonaws.com/private/5/abc-해지신청서.pdf';

    test('filePath 배열을 원소별로 redact 한다 (등록/수정 본문)', () => {
      const out = sanitize({ title: 't', filePath: [attach, attach] }, '/user-drive');
      expect(out.filePath).toEqual(['***', '***']);
      expect(JSON.stringify(out)).not.toContain('private/5');
      expect(JSON.stringify(out)).not.toContain('해지신청서');
    });

    test('문자열 하나여도 redact 한다', () => {
      expect(sanitize({ fileUrl: attach }, '/user-drive').fileUrl).toBe('***');
    });

    test('키 대소문자 무관하게 redact 한다', () => {
      expect(sanitize({ FilePath: [attach] }, '/user-drive').FilePath).toEqual(['***']);
    });

    test('빈 배열/ null 은 형태를 유지한다 (과잉 변형 방지)', () => {
      expect(sanitize({ filePath: [] }, '/user-drive').filePath).toEqual([]);
      expect(sanitize({ filePath: null }, '/user-drive').filePath).toBeNull();
    });

    test('첨부와 무관한 키는 그대로 둔다', () => {
      expect(sanitize({ title: '제목', content: '내용' }, '/user-drive').title).toBe('제목');
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

    // 입금내역 화면의 입금처 검색어는 예금주 실명이다. activity_log 에는 마스킹해서 남기는데
    // 여기서 빠뜨리면 HTTP 접근 로그에 실명이 평문으로 남아 그 마스킹이 옆 채널에서 무력화된다.
    test('depositor(예금주 실명) 검색어를 이름 마스킹한다', () => {
      expect(maskUrl('/deposit/list?depositor=두성종이&page=1')).toBe('/deposit/list?depositor=두***&page=1');
    });

    test('depositorRaw 도 함께 마스킹된다 (부분일치 규칙)', () => {
      expect(maskUrl('/deposit/list?depositorRaw=한빛문구')).toBe('/deposit/list?depositorRaw=한***');
    });

    // 첨부 다운로드 프록시(user-drive/order-receipt)는 S3 URL 을 쿼리로 받는다. key 가
    // private/{업로더id}/{uuid}-{원본명} 이라 업로더와 원본 파일명이 접근 로그에 그대로 쌓인다.
    // 파일은 private 라 key 를 안다고 받아지진 않지만, 로그 열람 권한이 파일 열람 권한보다 넓어
    // "파일은 못 보는 사람이 누가 무슨 파일을 올렸는지는 다 보는" 상태가 된다.
    test('fileUrl(첨부 S3 URL) 을 redact 한다 — 업로더 id·원본 파일명 노출 차단', () => {
      const out = maskUrl(
        '/user-drive/12/file/download?fileUrl=https://b.s3.amazonaws.com/private/5/abc-해지신청서.pdf',
      );
      expect(out).toBe('/user-drive/12/file/download?fileUrl=***');
      expect(out).not.toContain('private/5');
      expect(out).not.toContain('해지신청서');
    });

    test('fileUrl 도 키 대소문자 무관하게 redact 한다', () => {
      expect(maskUrl('/x?FILEURL=https://b.s3.amazonaws.com/private/5/a.pdf')).toBe('/x?FILEURL=***');
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

    test('sendEncryptKey 쿼리 파라미터를 redact한다', () => {
      expect(maskUrl('/x?sendEncryptKey=abc123')).toBe('/x?sendEncryptKey=***');
    });

    test('email 쿼리 파라미터는 @ 있으면 부분 마스킹한다', () => {
      const out = maskUrl('/user?email=hong@example.com');
      expect(out).not.toContain('hong@example.com');
      expect(out).toContain('@example.com');
    });

    test('email 쿼리 파라미터는 @ 없으면 원문 보존한다', () => {
      expect(maskUrl('/x?email=invalid')).toBe('/x?email=invalid');
    });

    test('personName 쿼리 파라미터를 부분 마스킹한다', () => {
      const out = maskUrl('/user-management?personName=홍길동&page=1');
      expect(out).toContain('personName=홍**');
      expect(out).toContain('page=1');
    });

    test('userPersonName 쿼리 파라미터를 부분 마스킹한다', () => {
      const out = maskUrl('/user-management?userPersonName=김철수&page=1');
      expect(out).toContain('userPersonName=김**');
      expect(out).toContain('page=1');
    });

    test('personPhoneNumber 쿼리 파라미터를 마스킹한다', () => {
      const out = maskUrl('/user-management?personPhoneNumber=01012345678');
      expect(out).toContain('personPhoneNumber=010-****-5678');
    });

    test('deliveryTarget 쿼리 파라미터를 마스킹한다', () => {
      const out = maskUrl('/customer-service?deliveryTarget=01012345678&status=COMPLETE');
      expect(out).toContain('deliveryTarget=');
      expect(out).not.toContain('01012345678');
      expect(out).toContain('status=COMPLETE');
    });

    test('businessNumber 쿼리 파라미터를 부분 마스킹한다', () => {
      const out = maskUrl('/corp?businessNumber=123-45-67890');
      expect(out).toContain('businessNumber=123-45-*****');
    });

    test('cardNumber 쿼리 파라미터를 부분 마스킹한다', () => {
      const out = maskUrl('/payment?cardNumber=1234567890123456');
      expect(out).toContain('cardNumber=1234-****-****-3456');
    });

    test('/user-biz/:bizNo path 세그먼트를 redact한다', () => {
      expect(maskUrl('/user-biz/123-45-67890')).toBe('/user-biz/123-45-*****');
    });

    test('/user-biz/:bizNo에 쿼리도 붙은 경우 path만 redact한다', () => {
      const out = maskUrl('/user-biz/123-45-67890?foo=bar');
      expect(out).toBe('/user-biz/123-45-*****?foo=bar');
    });

    test('address allowlist 쿼리 파라미터를 redact한다', () => {
      const out = maskUrl('/order?businessAddress=서울시 강남구&page=1');
      expect(out).toContain('businessAddress=***');
      expect(out).toContain('page=1');
    });

    test('allowlist 외 address 쿼리 파라미터는 보존한다', () => {
      expect(maskUrl('/x?addressType=HOME')).toBe('/x?addressType=HOME');
    });
  });
});
