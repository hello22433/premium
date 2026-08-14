import { orderCancelTemplate, orderPartialCancelTemplate } from './order.cancel.mail.template';

describe('orderCancelTemplate', () => {
  const base = {
    personName: '김담당',
    code: 'ORD-20260619-0007',
    eventName: '6월 감사 이벤트',
    cancelReason: '고객사 요청',
    canceledAt: '2026-06-19 14:32:05',
  };

  it('제목에 주문번호를 포함한다', () => {
    const { title } = orderCancelTemplate(base);
    expect(title).toBe('주문이 취소되었습니다 (주문번호: ORD-20260619-0007)');
  });

  it('본문에 담당자명·주문번호·이벤트명·취소사유·취소일시를 담는다', () => {
    const { content } = orderCancelTemplate(base);
    expect(content).toContain('김담당');
    expect(content).toContain('ORD-20260619-0007');
    expect(content).toContain('6월 감사 이벤트');
    expect(content).toContain('고객사 요청');
    expect(content).toContain('2026-06-19 14:32:05');
    expect(content).toContain('본 메일로 회신');
    expect(content).toContain('이팝콘 프리미엄');
  });

  it('cancelReason 이 null 이면 "-" 로 렌더한다', () => {
    const { content } = orderCancelTemplate({ ...base, cancelReason: null });
    expect(content).toContain('취소사유: -');
  });

  it('personName 이 비면 "고객" 으로 대체한다', () => {
    const { content } = orderCancelTemplate({ ...base, personName: '' });
    expect(content).toContain('고객님,');
  });

  it('사용자 입력의 <, > 를 이스케이프한다', () => {
    const { content } = orderCancelTemplate({ ...base, eventName: '<b>x</b>' });
    expect(content).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(content).not.toContain('<b>x</b>');
  });
});

describe('orderPartialCancelTemplate (197-16)', () => {
  const base = {
    personName: '김담당',
    code: 'ORD-20260722-0011',
    eventName: '7월 프로모션',
    canceledCount: 3,
    waitingCount: 12,
    cancelReason: '수량 조정',
    canceledAt: '2026-07-22 10:05:00',
  };

  // ★ 전체취소 문안("주문이 취소되었습니다")을 재사용하면, 잔여분이 예정대로 나가는데도
  //   고객에게 주문 전체가 취소됐다고 알리게 된다. 두 문안이 섞이지 않도록 고정한다.
  it('주문 전체가 취소된 것처럼 읽히지 않는다', () => {
    const { title, content } = orderPartialCancelTemplate(base);
    expect(title).toBe('예약 발송 건이 일부 취소되었습니다 (주문번호: ORD-20260722-0011)');
    expect(title).not.toContain('주문이 취소되었습니다');
    expect(content).toContain('남은 건은 예정대로 발송됩니다');
  });

  it('취소된 건수와 남은 건수를 함께 알린다', () => {
    const { content } = orderPartialCancelTemplate(base);
    expect(content).toContain('취소된 발송 건수: 3건');
    expect(content).toContain('앞으로 발송될 건수: 12건');
    expect(content).toContain('수량 조정');
    expect(content).toContain('2026-07-22 10:05:00');
  });

  it('사용자 입력을 이스케이프한다', () => {
    const { content } = orderPartialCancelTemplate({ ...base, cancelReason: '<script>alert(1)</script>' });
    expect(content).toContain('&lt;script&gt;');
    expect(content).not.toContain('<script>');
  });
});
