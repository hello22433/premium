import { BadRequestException } from '@nestjs/common';
import { PartnerSettleReviewQueryService } from './partner.settle.review.query.service';

const createdAt = new Date('2026-08-06T00:00:00.000Z');
const createdAtRaw = '2026-08-06 00:00:00.000000';
function build(rows: Record<string, unknown>[] = []) {
  const dataSource = { query: jest.fn().mockResolvedValue(rows) };
  return { service: new PartnerSettleReviewQueryService(dataSource as never), dataSource };
}

describe('PartnerSettleReviewQueryService', () => {
  it('uses the canonical three sources, stable order, and a filter-bound cursor', async () => {
    const rows = [
      {
        source: 'LEDGER',
        id: 1,
        partner_company_id: 9,
        order_delivery_id: 2,
        status: 'NEEDS_REVIEW',
        review_code: 'COVERAGE_GAP',
        base_amount: '9007199254740993',
        occurred_at: null,
        created_at: createdAt,
        created_at_raw: createdAtRaw,
      },
      {
        source: 'ORPHAN_EVENT',
        id: 3,
        partner_company_id: 9,
        order_delivery_id: 3,
        status: 'ORPHAN_PENDING',
        review_code: null,
        base_amount: null,
        occurred_at: null,
        created_at: createdAt,
        created_at_raw: createdAtRaw,
        inbox_row_id: 3,
        ingress_fingerprint: 'fingerprint',
        normalized_payload: '{"event":"missing-time"}',
      },
    ];
    const { service, dataSource } = build(rows);

    const result = await service.findNeedsReview({ partnerCompanyId: 9, limit: 1 });

    expect(result.items[0].baseAmount).toBe('9007199254740993');
    expect(result.nextCursor).toEqual(expect.any(String));
    expect(dataSource.query.mock.calls[0][0]).toContain("'TRANSITION_OBSERVATION'");
    expect(dataSource.query.mock.calls[0][0]).toContain("'ORPHAN_EVENT'");
    expect(dataSource.query.mock.calls[0][0]).toContain('ORDER BY q.created_at ASC, q.source ASC, q.id ASC');
    await expect(service.findNeedsReview({ partnerCompanyId: 10, cursor: result.nextCursor! })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('cursor preserves DATETIME(6) microseconds — no duplicates across µs boundary', async () => {
    const rows = [
      {
        source: 'LEDGER',
        id: 10,
        partner_company_id: 1,
        order_delivery_id: 2,
        status: 'NEEDS_REVIEW',
        review_code: null,
        base_amount: '1000',
        occurred_at: null,
        created_at: new Date('2026-08-06T12:00:00.123Z'),
        created_at_raw: '2026-08-06 12:00:00.123456',
      },
      {
        source: 'TRANSITION_OBSERVATION',
        id: 20,
        partner_company_id: 1,
        order_delivery_id: 3,
        status: 'UNRESOLVED',
        review_code: null,
        base_amount: null,
        occurred_at: null,
        created_at: new Date('2026-08-06T12:00:00.123Z'),
        created_at_raw: '2026-08-06 12:00:00.123789',
        inbox_row_id: null,
        ingress_fingerprint: null,
        normalized_payload: null,
      },
    ];
    const { service, dataSource } = build(rows);

    const page1 = await service.findNeedsReview({ limit: 1 });

    // cursor must encode the raw µs string, not the ms-truncated JS Date
    const payload = JSON.parse(Buffer.from(page1.nextCursor!, 'base64url').toString('utf8'));
    expect(payload.createdAt).toBe('2026-08-06 12:00:00.123456');

    // page 2 request passes the µs-accurate string as SQL param
    await service.findNeedsReview({ cursor: page1.nextCursor! });
    const p2 = dataSource.query.mock.calls[1][1] as unknown[];
    // params layout: [createdAt, createdAt, source, source, id, limit+1]
    expect(p2[0]).toBe('2026-08-06 12:00:00.123456');
    expect(p2[1]).toBe('2026-08-06 12:00:00.123456');
  });

  it('accepts legacy ISO-format cursors and converts UTC → KST', async () => {
    const legacyCursor = Buffer.from(
      JSON.stringify({
        createdAt: '2026-08-06T00:00:00.000Z',
        source: 'LEDGER',
        id: 1,
        filters: { partnerCompanyId: 9, status: null, reviewCode: null, source: null },
      }),
    ).toString('base64url');
    const { service, dataSource } = build([]);

    await service.findNeedsReview({ partnerCompanyId: 9, cursor: legacyCursor });

    // UTC 00:00 → KST 09:00, padded to DATETIME(6)
    const params = dataSource.query.mock.calls[0][1] as unknown[];
    expect(params[1]).toBe('2026-08-06 09:00:00.000000');
    expect(params[2]).toBe('2026-08-06 09:00:00.000000');
  });

  it.each([
    ['Z (UTC)',    '2026-08-06T03:00:00.123Z',       '2026-08-06 12:00:00.123000'],
    ['+09:00',     '2026-08-06T12:00:00.456+09:00',  '2026-08-06 12:00:00.456000'],
    ['-04:00',     '2026-08-06T03:00:00.789-04:00',  '2026-08-06 16:00:00.789000'],
  ])('legacy ISO cursor with offset %s converts to KST correctly', async (_label, iso, expected) => {
    const cursor = Buffer.from(
      JSON.stringify({
        createdAt: iso,
        source: 'LEDGER',
        id: 1,
        filters: { partnerCompanyId: 9, status: null, reviewCode: null, source: null },
      }),
    ).toString('base64url');
    const { service, dataSource } = build([]);

    await service.findNeedsReview({ partnerCompanyId: 9, cursor: cursor });

    const params = dataSource.query.mock.calls[0][1] as unknown[];
    expect(params[1]).toBe(expected);
    expect(params[2]).toBe(expected);
  });

  it('rejects malformed cursors and invalid limits', async () => {
    const { service } = build();
    await expect(service.findNeedsReview({ cursor: 'not-base64' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.findNeedsReview({ limit: 201 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns proposal inbox status and ledger IDs, including no linked ledger', async () => {
    const { service, dataSource } = build([
      {
        id: 4,
        provider: 'GALAXIA',
        partner_company_id: 7,
        order_delivery_id: 8,
        inbox_row_id: 9,
        resolution_mode: 'LEDGER',
        proposed_ledger_facts: '{"baseAmount":"9007199254740993"}',
        status: 'APPROVED',
        inbox_status: 'ORPHAN_LEDGERED',
        ledger_ids: '[11,12]',
        created_at: createdAt,
      },
      {
        id: 5,
        provider: 'GALAXIA',
        partner_company_id: 7,
        order_delivery_id: 8,
        inbox_row_id: 10,
        resolution_mode: 'DISCARD',
        proposed_ledger_facts: null,
        status: 'PENDING',
        inbox_status: 'ORPHAN_PENDING',
        ledger_ids: '[null]',
        created_at: createdAt,
      },
    ]);

    const result = await service.findManualLedgerProposals({ partnerCompanyId: 7 });

    expect(result.items).toEqual([
      expect.objectContaining({ inboxStatus: 'ORPHAN_LEDGERED', ledgerIds: [11, 12] }),
      expect.objectContaining({ inboxStatus: 'ORPHAN_PENDING', ledgerIds: [] }),
    ]);
    expect(dataSource.query.mock.calls[0][0]).toContain('IF(COUNT(l.id) = 0, JSON_ARRAY(), JSON_ARRAYAGG(l.id))');
    expect(dataSource.query.mock.calls[0][0]).toContain(
      'COALESCE(choice_product.partner_company_id, product.partner_company_id)',
    );
  });

  it('queries every ORPHAN_PENDING row without excluding rejected proposal history', async () => {
    const { service, dataSource } = build([
      {
        inbox_row_id: 9,
        provider: 'GALAXIA',
        partner_company_id: 7,
        order_delivery_id: 8,
        source_type: 'EXCHANGE',
        ingress_fingerprint: 'fp',
        normalized_payload: '{"event":"missing-time"}',
        created_at: createdAt,
      },
    ]);

    const result = await service.findOrphanInbox({ partnerCompanyId: 7 });

    expect(result.items[0].inboxRowId).toBe(9);
    const sql = dataSource.query.mock.calls[0][0] as string;
    expect(sql).toContain("i.processed_status = 'ORPHAN_PENDING'");
    expect(sql).not.toContain('manual_ledger_proposal');
  });
});
