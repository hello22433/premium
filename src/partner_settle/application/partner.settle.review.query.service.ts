import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

export type ReviewSource = 'LEDGER' | 'TRANSITION_OBSERVATION' | 'ORPHAN_EVENT';
export type ReviewQuery = {
  partnerCompanyId?: number;
  status?: string;
  reviewCode?: string;
  source?: ReviewSource;
  limit?: number;
  cursor?: string;
};
export type ReviewItem = {
  source: ReviewSource;
  id: number;
  partnerCompanyId: number | null;
  orderDeliveryId: number | null;
  status: string;
  reviewCode: string | null;
  baseAmount: string | null;
  occurredAt: Date | null;
  createdAt: Date;
  orphanEvidence: { inboxRowId: number; ingressFingerprint: string; normalizedPayload: Record<string, unknown> } | null;
};
export type ManualLedgerProposalQuery = {
  partnerCompanyId?: number;
  orderDeliveryId?: number;
  status?: 'PENDING' | 'APPROVED' | 'REJECTED';
  limit?: number;
  cursor?: string;
};
export type ManualLedgerProposalItem = {
  id: number;
  provider: string;
  partnerCompanyId: number | null;
  orderDeliveryId: number;
  inboxRowId: number;
  resolutionMode: 'LEDGER' | 'DISCARD';
  proposedLedgerFacts: Record<string, unknown> | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  inboxStatus: string | null;
  ledgerIds: number[];
  createdAt: Date;
};
export type OrphanInboxItem = {
  inboxRowId: number;
  provider: string;
  partnerCompanyId: number | null;
  orderDeliveryId: number;
  sourceType: string;
  ingressFingerprint: string;
  normalizedPayload: Record<string, unknown>;
  createdAt: Date;
};

@Injectable()
export class PartnerSettleReviewQueryService {
  constructor(private readonly dataSource: DataSource) {}

  async findNeedsReview(query: ReviewQuery): Promise<{ items: ReviewItem[]; nextCursor: string | null }> {
    const limit = validateLimit(query.limit);
    const filters = reviewFilters(query);
    const cursor = decodeCursor(query.cursor, filters, ['LEDGER', 'TRANSITION_OBSERVATION', 'ORPHAN_EVENT']);
    const params: unknown[] = [];
    const filtersSql = appendReviewFilters(query, params);
    if (cursor) params.push(cursor.createdAt, cursor.createdAt, cursor.source, cursor.source, cursor.id);
    params.push(limit + 1);

    const rows = (await this.dataSource.query(
      `SELECT q.*, DATE_FORMAT(q.created_at, '%Y-%m-%d %H:%i:%s.%f') AS created_at_raw FROM (
        SELECT 'LEDGER' AS source, l.id, l.partner_company_id, l.order_delivery_id, l.status, l.review_code,
               l.base_amount, l.occurred_at, l.created_at, NULL AS inbox_row_id, NULL AS ingress_fingerprint,
               NULL AS normalized_payload
          FROM partner_settle_ledger l
         WHERE l.status = 'NEEDS_REVIEW' AND (l.review_resolution IS NULL OR l.review_resolution = 'PENDING')
        UNION ALL
        SELECT 'TRANSITION_OBSERVATION', o.id, COALESCE(choice_product.partner_company_id, product.partner_company_id),
               o.order_delivery_id, o.resolution_status, NULL, NULL, o.observed_at, o.created_at, NULL, NULL, NULL
          FROM partner_settle_transition_observation o
          LEFT JOIN order_delivery od ON od.id = o.order_delivery_id
          LEFT JOIN order_product_mapping opm ON opm.id = od.order_product_mapping_id
          LEFT JOIN product ON product.id = opm.product_id
          LEFT JOIN product choice_product ON choice_product.id = od.choice_select_product_id
         WHERE o.resolution_status = 'UNRESOLVED'
        UNION ALL
        SELECT 'ORPHAN_EVENT', i.id, COALESCE(choice_product.partner_company_id, product.partner_company_id),
               i.order_delivery_id, i.processed_status, NULL, NULL, NULL, i.created_at, i.id,
               i.ingress_fingerprint, i.normalized_payload
          FROM partner_provider_event_inbox i
          LEFT JOIN order_delivery od ON od.id = i.order_delivery_id
          LEFT JOIN order_product_mapping opm ON opm.id = od.order_product_mapping_id
          LEFT JOIN product ON product.id = opm.product_id
          LEFT JOIN product choice_product ON choice_product.id = od.choice_select_product_id
         WHERE i.origin = 'ORPHAN' AND i.processed_status = 'ORPHAN_PENDING'
      ) q
      WHERE 1 = 1 ${filtersSql}
        ${cursor ? 'AND (q.created_at > ? OR (q.created_at = ? AND (q.source > ? OR (q.source = ? AND q.id > ?))))' : ''}
      ORDER BY q.created_at ASC, q.source ASC, q.id ASC
      LIMIT ?`,
      params,
    )) as Array<Record<string, unknown>>;
    const items = rows.slice(0, limit).map(mapReviewRow);
    const lastRow = rows.length > limit ? rows[limit - 1] : null;
    return {
      items,
      nextCursor: lastRow
        ? encodeCursor(
            { createdAt: String(lastRow.created_at_raw), id: Number(lastRow.id), source: lastRow.source as ReviewSource },
            filters,
          )
        : null,
    };
  }

  async findManualLedgerProposals(
    query: ManualLedgerProposalQuery,
  ): Promise<{ items: ManualLedgerProposalItem[]; nextCursor: string | null }> {
    const limit = validateLimit(query.limit);
    const filters = proposalFilters(query);
    const cursor = decodeCursor(query.cursor, filters, []);
    const params: unknown[] = [];
    const where = appendProposalFilters(query, params);
    if (cursor) params.push(cursor.createdAt, cursor.createdAt, cursor.id);
    params.push(limit + 1);
    const rows = (await this.dataSource.query(
      `SELECT p.id, p.provider, COALESCE(choice_product.partner_company_id, product.partner_company_id) AS partner_company_id,
              p.order_delivery_id, p.inbox_row_id, p.resolution_mode, p.proposed_ledger_facts, p.status,
              i.processed_status AS inbox_status, p.created_at,
              DATE_FORMAT(p.created_at, '%Y-%m-%d %H:%i:%s.%f') AS created_at_raw,
              IF(COUNT(l.id) = 0, JSON_ARRAY(), JSON_ARRAYAGG(l.id)) AS ledger_ids
         FROM partner_provider_manual_ledger_proposal p
         LEFT JOIN partner_provider_event_inbox i ON i.id = p.inbox_row_id
         LEFT JOIN order_delivery od ON od.id = p.order_delivery_id
         LEFT JOIN order_product_mapping opm ON opm.id = od.order_product_mapping_id
         LEFT JOIN product ON product.id = opm.product_id
         LEFT JOIN product choice_product ON choice_product.id = od.choice_select_product_id
         LEFT JOIN partner_settle_ledger l ON l.manual_ledger_proposal_id = p.id
        WHERE 1 = 1 ${where}
          ${cursor ? 'AND (p.created_at > ? OR (p.created_at = ? AND p.id > ?))' : ''}
        GROUP BY p.id, p.provider, choice_product.partner_company_id, product.partner_company_id, p.order_delivery_id,
                 p.inbox_row_id, p.resolution_mode, p.proposed_ledger_facts, p.status, i.processed_status, p.created_at
        ORDER BY p.created_at ASC, p.id ASC
        LIMIT ?`,
      params,
    )) as Array<Record<string, unknown>>;
    const items = rows.slice(0, limit).map(mapProposalRow);
    const lastRow = rows.length > limit ? rows[limit - 1] : null;
    return {
      items,
      nextCursor: lastRow
        ? encodeCursor({ createdAt: String(lastRow.created_at_raw), id: Number(lastRow.id) }, filters)
        : null,
    };
  }

  async findOrphanInbox(
    query: Omit<ManualLedgerProposalQuery, 'status'>,
  ): Promise<{ items: OrphanInboxItem[]; nextCursor: string | null }> {
    const limit = validateLimit(query.limit);
    const filters = orphanFilters(query);
    const cursor = decodeCursor(query.cursor, filters, []);
    const params: unknown[] = [];
    const where = appendOrphanFilters(query, params);
    if (cursor) params.push(cursor.createdAt, cursor.createdAt, cursor.id);
    params.push(limit + 1);
    const rows = (await this.dataSource.query(
      `SELECT i.id AS inbox_row_id, i.provider, COALESCE(choice_product.partner_company_id, product.partner_company_id) AS partner_company_id,
              i.order_delivery_id, i.source_type, i.ingress_fingerprint, i.normalized_payload, i.created_at,
              DATE_FORMAT(i.created_at, '%Y-%m-%d %H:%i:%s.%f') AS created_at_raw
         FROM partner_provider_event_inbox i
         LEFT JOIN order_delivery od ON od.id = i.order_delivery_id
         LEFT JOIN order_product_mapping opm ON opm.id = od.order_product_mapping_id
         LEFT JOIN product ON product.id = opm.product_id
         LEFT JOIN product choice_product ON choice_product.id = od.choice_select_product_id
        WHERE i.origin = 'ORPHAN' AND i.processed_status = 'ORPHAN_PENDING' ${where}
          ${cursor ? 'AND (i.created_at > ? OR (i.created_at = ? AND i.id > ?))' : ''}
        ORDER BY i.created_at ASC, i.id ASC
        LIMIT ?`,
      params,
    )) as Array<Record<string, unknown>>;
    const items = rows.slice(0, limit).map(mapOrphanRow);
    const lastRow = rows.length > limit ? rows[limit - 1] : null;
    return {
      items,
      nextCursor: lastRow
        ? encodeCursor({ createdAt: String(lastRow.created_at_raw), id: Number(lastRow.inbox_row_id) }, filters)
        : null,
    };
  }
}

function validateLimit(limit?: number): number {
  const value = limit ?? 50;
  if (!Number.isInteger(value) || value < 1 || value > 200)
    throw new BadRequestException('limit은 1~200이어야 합니다.');
  return value;
}
function reviewFilters(query: ReviewQuery): Record<string, unknown> {
  return {
    partnerCompanyId: query.partnerCompanyId ?? null,
    status: query.status ?? null,
    reviewCode: query.reviewCode ?? null,
    source: query.source ?? null,
  };
}
function proposalFilters(query: ManualLedgerProposalQuery): Record<string, unknown> {
  return {
    partnerCompanyId: query.partnerCompanyId ?? null,
    orderDeliveryId: query.orderDeliveryId ?? null,
    status: query.status ?? null,
  };
}
function orphanFilters(query: Omit<ManualLedgerProposalQuery, 'status'>): Record<string, unknown> {
  return { partnerCompanyId: query.partnerCompanyId ?? null, orderDeliveryId: query.orderDeliveryId ?? null };
}
function appendReviewFilters(query: ReviewQuery, params: unknown[]): string {
  let sql = '';
  if (query.source) {
    sql += ' AND q.source = ?';
    params.push(query.source);
  }
  if (query.partnerCompanyId !== undefined) {
    sql += ' AND q.partner_company_id = ?';
    params.push(query.partnerCompanyId);
  }
  if (query.status) {
    sql += ' AND q.status = ?';
    params.push(query.status);
  }
  if (query.reviewCode) {
    sql += ' AND q.review_code = ?';
    params.push(query.reviewCode);
  }
  return sql;
}
function appendProposalFilters(query: ManualLedgerProposalQuery, params: unknown[]): string {
  let sql = '';
  if (query.partnerCompanyId !== undefined) {
    sql += ' AND COALESCE(choice_product.partner_company_id, product.partner_company_id) = ?';
    params.push(query.partnerCompanyId);
  }
  if (query.orderDeliveryId !== undefined) {
    sql += ' AND p.order_delivery_id = ?';
    params.push(query.orderDeliveryId);
  }
  if (query.status) {
    sql += ' AND p.status = ?';
    params.push(query.status);
  }
  return sql;
}
function appendOrphanFilters(query: Omit<ManualLedgerProposalQuery, 'status'>, params: unknown[]): string {
  let sql = '';
  if (query.partnerCompanyId !== undefined) {
    sql += ' AND COALESCE(choice_product.partner_company_id, product.partner_company_id) = ?';
    params.push(query.partnerCompanyId);
  }
  if (query.orderDeliveryId !== undefined) {
    sql += ' AND i.order_delivery_id = ?';
    params.push(query.orderDeliveryId);
  }
  return sql;
}
function mapReviewRow(row: Record<string, unknown>): ReviewItem {
  const inboxRowId = row.inbox_row_id === null ? null : Number(row.inbox_row_id);
  return {
    source: row.source as ReviewSource,
    id: Number(row.id),
    partnerCompanyId: toNumberOrNull(row.partner_company_id),
    orderDeliveryId: toNumberOrNull(row.order_delivery_id),
    status: String(row.status),
    reviewCode: row.review_code === null ? null : String(row.review_code),
    baseAmount: row.base_amount === null ? null : String(row.base_amount),
    occurredAt: toDateOrNull(row.occurred_at),
    createdAt: new Date(row.created_at as string),
    orphanEvidence:
      inboxRowId === null
        ? null
        : {
            inboxRowId,
            ingressFingerprint: String(row.ingress_fingerprint),
            normalizedPayload: parseJson(row.normalized_payload) as Record<string, unknown>,
          },
  };
}
function mapProposalRow(row: Record<string, unknown>): ManualLedgerProposalItem {
  return {
    id: Number(row.id),
    provider: String(row.provider),
    partnerCompanyId: toNumberOrNull(row.partner_company_id),
    orderDeliveryId: Number(row.order_delivery_id),
    inboxRowId: Number(row.inbox_row_id),
    resolutionMode: row.resolution_mode as 'LEDGER' | 'DISCARD',
    proposedLedgerFacts:
      row.proposed_ledger_facts === null ? null : (parseJson(row.proposed_ledger_facts) as Record<string, unknown>),
    status: row.status as 'PENDING' | 'APPROVED' | 'REJECTED',
    inboxStatus: row.inbox_status === null ? null : String(row.inbox_status),
    ledgerIds: (parseJson(row.ledger_ids) as unknown[])
      .filter((id): id is number | string => id !== null && id !== undefined && Number.isInteger(Number(id)))
      .map(Number),
    createdAt: new Date(row.created_at as string),
  };
}
function mapOrphanRow(row: Record<string, unknown>): OrphanInboxItem {
  return {
    inboxRowId: Number(row.inbox_row_id),
    provider: String(row.provider),
    partnerCompanyId: toNumberOrNull(row.partner_company_id),
    orderDeliveryId: Number(row.order_delivery_id),
    sourceType: String(row.source_type),
    ingressFingerprint: String(row.ingress_fingerprint),
    normalizedPayload: parseJson(row.normalized_payload) as Record<string, unknown>,
    createdAt: new Date(row.created_at as string),
  };
}
function toNumberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}
function toDateOrNull(value: unknown): Date | null {
  return value === null || value === undefined ? null : new Date(value as string);
}
function parseJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}
function encodeCursor(
  item: { createdAt: string; id: number; source?: ReviewSource },
  filters: Record<string, unknown>,
): string {
  return Buffer.from(
    JSON.stringify({ createdAt: item.createdAt, source: item.source ?? null, id: item.id, filters }),
  ).toString('base64url');
}
/** Convert ISO 8601 timestamp (any offset) to KST MySQL DATETIME(6) string. */
function isoToKstDatetime(iso: string): string {
  const d = new Date(iso);
  const kst = new Date(d.getTime() + 9 * 3_600_000);
  const p = (n: number, len: number) => String(n).padStart(len, '0');
  return (
    `${kst.getUTCFullYear()}-${p(kst.getUTCMonth() + 1, 2)}-${p(kst.getUTCDate(), 2)} ` +
    `${p(kst.getUTCHours(), 2)}:${p(kst.getUTCMinutes(), 2)}:${p(kst.getUTCSeconds(), 2)}.${p(kst.getUTCMilliseconds(), 3)}000`
  );
}
function decodeCursor(
  raw: string | undefined,
  filters: Record<string, unknown>,
  sources: ReviewSource[],
): { createdAt: string; source: ReviewSource; id: number } | { createdAt: string; source: null; id: number } | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<string, unknown>;
    const rawCreatedAt = String(value.createdAt);
    if (Number.isNaN(new Date(rawCreatedAt).getTime())) throw new Error();
    // Legacy cursors are UTC ISO 8601; convert to KST MySQL DATETIME(6)
    const createdAt = rawCreatedAt.includes('T')
      ? isoToKstDatetime(rawCreatedAt)
      : rawCreatedAt;
    const source = value.source === null ? null : (value.source as ReviewSource);
    const id = Number(value.id);
    if (
      !Number.isInteger(id) ||
      id < 1 ||
      JSON.stringify(value.filters) !== JSON.stringify(filters) ||
      (sources.length > 0 && !sources.includes(source as ReviewSource)) ||
      (sources.length === 0 && source !== null)
    )
      throw new Error();
    return { createdAt, source, id };
  } catch {
    throw new BadRequestException('cursor가 올바르지 않거나 현재 필터와 일치하지 않습니다.');
  }
}
