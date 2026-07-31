import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  OrderGetDeliveryCompleteReportPdfReqDto,
  OrderGetOrderCompleteReportPdfReqDto,
  OrderGetReportHistoryReqQueryDto,
} from './order.req.dto';
import { IReportSource, REPORT_HISTORY_TYPES } from '../interface/report.source';

/**
 * PDF 발행 API 의 source 파라미터 검증.
 *
 * 고정하는 계약:
 *  1) DOCUMENT / DIRECT 만 허용 — 오타가 조용히 '다운로드 완료'로 폴백하지 않게
 *  2) EMAIL 은 거부 — 서버가 메일 전송 경로에서만 기록하는 값이라, 클라이언트가 자칭하면
 *     메일을 한 통도 보내지 않고 정산 목록을 '발행 완료'로 만들 수 있다
 *  3) 미전송 / 빈 문자열은 허용 — @IsOptional 은 null/undefined 만 건너뛰므로 '' 를 정규화하지
 *     않으면 기존에 200 이던 요청이 400 이 된다(계약 회귀)
 */

const validateSource = (Dto: any, source: unknown) => {
  const payload: Record<string, unknown> = { id: 14 };
  if (source !== undefined) payload.source = source;
  const dto = plainToInstance(Dto, payload);
  const errors = validateSync(dto as object, { whitelist: true });
  return { errors: errors.filter((e) => e.property === 'source'), value: (dto as any).source };
};

describe.each([
  ['발송완료리포트', OrderGetDeliveryCompleteReportPdfReqDto],
  ['거래명세서', OrderGetOrderCompleteReportPdfReqDto],
])('%s PDF 발행 — source 검증', (_label, Dto) => {
  it('DOCUMENT 를 허용한다', () => {
    expect(validateSource(Dto, IReportSource.DOCUMENT).errors).toHaveLength(0);
  });

  it('DIRECT 를 허용한다', () => {
    expect(validateSource(Dto, IReportSource.DIRECT).errors).toHaveLength(0);
  });

  it('EMAIL 을 거부한다 (메일 안 보내고 발행 완료 자칭 차단)', () => {
    expect(validateSource(Dto, IReportSource.EMAIL).errors.length).toBeGreaterThan(0);
  });

  it('오타를 거부한다 (조용한 다운로드 폴백 차단)', () => {
    expect(validateSource(Dto, 'DIRECTT').errors.length).toBeGreaterThan(0);
  });

  it('소문자를 거부한다', () => {
    expect(validateSource(Dto, 'direct').errors.length).toBeGreaterThan(0);
  });

  it('미전송을 허용한다 (optional 유지)', () => {
    expect(validateSource(Dto, undefined).errors).toHaveLength(0);
  });

  it('빈 문자열을 허용하고 undefined 로 정규화한다 (기존 계약 보존)', () => {
    const { errors, value } = validateSource(Dto, '');

    expect(errors).toHaveLength(0);
    // undefined 로 접혀야 서비스의 `getBody.source || DOCUMENT` 폴백이 그대로 동작한다.
    expect(value).toBeUndefined();
  });

  it('null 을 허용한다', () => {
    expect(validateSource(Dto, null).errors).toHaveLength(0);
  });
});

/**
 * 발행 이력 조회의 reportType 검증.
 *
 * 미검증 문자열은 조회 서비스의 actionType 매핑을 인덱싱한다. 목록 밖 값이 들어오면
 * 200 + 빈 결과로 조용히 폴백해, 실제로 발행된 주문에 "이력 없음"이 뜬다.
 * 프론트 오타가 배포 후에도 드러나지 않으므로 400 으로 즉시 실패시킨다.
 */
const validateReportType = (reportType: unknown) => {
  const dto = plainToInstance(OrderGetReportHistoryReqQueryDto, { reportType });
  return validateSync(dto as object).filter((e) => e.property === 'reportType');
};

describe('발행 이력 조회 — reportType 검증', () => {
  it.each(REPORT_HISTORY_TYPES)('허용 목록의 %s 를 통과시킨다', (type) => {
    expect(validateReportType(type)).toHaveLength(0);
  });

  it.each(['TRANSACTION_STATMENT', 'DELIVERY_COMPLETE', 'delivery_complete_report', 'ORDER_DELETE'])(
    "목록 밖 값 '%s' 를 거부한다 (조용한 빈 결과 폴백 차단)",
    (type) => {
      expect(validateReportType(type).length).toBeGreaterThan(0);
    },
  );

  it.each(['constructor', 'toString', '__proto__', 'valueOf'])("프로토타입 멤버 '%s' 를 거부한다", (type) => {
    expect(validateReportType(type).length).toBeGreaterThan(0);
  });

  it('미전송을 거부한다 (필수 파라미터)', () => {
    expect(validateReportType(undefined).length).toBeGreaterThan(0);
  });

  it('빈 문자열을 거부한다', () => {
    expect(validateReportType('').length).toBeGreaterThan(0);
  });
});
