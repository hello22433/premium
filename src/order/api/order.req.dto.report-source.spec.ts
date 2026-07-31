import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { OrderGetDeliveryCompleteReportPdfReqDto, OrderGetOrderCompleteReportPdfReqDto } from './order.req.dto';
import { IReportSource } from '../interface/report.source';

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
