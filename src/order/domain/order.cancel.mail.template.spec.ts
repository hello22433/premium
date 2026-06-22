import { orderCancelTemplate } from './order.cancel.mail.template';

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
