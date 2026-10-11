/**
 * Query Optimization Module
 * 
 * Features:
 * - Offset and cursor-based pagination
 * - Batch loading to prevent N+1 queries
 * - Eager loading configurations
 * - Query performance monitoring (slow query detection)
 * - Database index recommendations
 * 
 * Usage:
 * const users = await paginate(page, limit);
 * const invoices = await prefetchForInvoice(invoiceIds);
 * const slow = await getSlowQueries(threshold);
 */

interface PaginationOptions {
  page: number;
  limit: number;
  maxLimit?: number;
}

interface CursorPaginationOptions {
  cursor?: string;
  limit: number;
  maxLimit?: number;
}

interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  hasMore: boolean;
}

interface CursorPaginatedResult<T> {
  data: T[];
  nextCursor?: string;
  hasMore: boolean;
}

/**
 * Offset-based pagination
 * Best for: Small datasets, sequential access
 * Worst for: Large offsets (slow), real-time updates
 */
export async function paginate<T>(
  query: any,
  options: PaginationOptions,
): Promise<PaginatedResult<T>> {
  const { page, limit, maxLimit = 100 } = options;

  // Validate inputs
  if (page < 1) throw new Error('Page must be >= 1');
  if (limit < 1 || limit > maxLimit) {
    throw new Error(`Limit must be between 1 and ${maxLimit}`);
  }

  const offset = (page - 1) * limit;

  // Execute count query
  const countResult = await query.clone().count('*').first();
  const total = parseInt(countResult?.count || 0);

  // Fetch paginated data
  const data = await query.offset(offset).limit(limit);

  const pageCount = Math.ceil(total / limit);

  return {
    data,
    total,
    page,
    pageSize: limit,
    pageCount,
    hasMore: page < pageCount,
  };
}

/**
 * Cursor-based pagination
 * Best for: Large datasets, real-time feeds, infinite scroll
 * Avoids the O(n) cost of OFFSET
 */
export async function cursorPaginate<T>(
  query: any,
  options: CursorPaginationOptions,
): Promise<CursorPaginatedResult<T>> {
  const { cursor, limit, maxLimit = 100 } = options;

  if (limit < 1 || limit > maxLimit) {
    throw new Error(`Limit must be between 1 and ${maxLimit}`);
  }

  let queryBuilder = query.clone();

  // Apply cursor filter if provided
  if (cursor) {
    const decodedCursor = Buffer.from(cursor, 'base64').toString('utf-8');
    const [field, value] = decodedCursor.split(':');

    // Assuming cursor is based on 'id' field
    queryBuilder = queryBuilder.where(field, '>', value);
  }

  // Fetch limit + 1 to detect if there are more results
  const data = await queryBuilder.limit(limit + 1);

  const hasMore = data.length > limit;
  const results = data.slice(0, limit);

  let nextCursor: string | undefined;
  if (hasMore && results.length > 0) {
    const lastItem = results[results.length - 1] as any;
    const cursorValue = `id:${lastItem.id}`;
    nextCursor = Buffer.from(cursorValue).toString('base64');
  }

  return {
    data: results as T[],
    nextCursor,
    hasMore,
  };
}

/**
 * Batch load relations to prevent N+1 queries
 * 
 * Example:
 * const invoices = await db.invoices.findMany();
 * const withLineItems = await batchLoadRelations(
 *   invoices,
 *   'lineItems',
 *   (ids) => db.lineItems.findMany({ where: { invoiceId: { in: ids } } })
 * );
 */
export async function batchLoadRelations<T extends { id: string | number }, R>(
  items: T[],
  relationField: string,
  loadFn: (ids: (string | number)[]) => Promise<Array<{ [key: string]: any }>>,
): Promise<Array<T & { [key: string]: R[] }>> {
  // Extract all IDs
  const ids = items.map((item) => item.id);

  // Batch load relations
  const relations = await loadFn(ids);

  // Create map for O(1) lookup
  const relationMap = new Map<string | number, R[]>();
  relations.forEach((rel) => {
    const parentId = rel.invoiceId || rel.billId || rel.parentId; // Adjust as needed
    if (!relationMap.has(parentId)) {
      relationMap.set(parentId, []);
    }
    relationMap.get(parentId)!.push(rel);
  });

  // Attach relations to items
  return items.map((item) => ({
    ...item,
    [relationField]: relationMap.get(item.id) || [],
  }));
}

/**
 * Prefetch relations for invoices (eager loading config)
 */
export async function prefetchForInvoice(invoiceIds: string[], db: any) {
  // Fetch invoices
  const invoices = await db.invoices.findMany({
    where: { id: { in: invoiceIds } },
  });

  // Batch load line items
  const withLineItems = await batchLoadRelations(invoices, 'lineItems', (ids) =>
    db.lineItems.findMany({
      where: { invoiceId: { in: ids } },
    }),
  );

  // Batch load tax details
  const withTaxes = await batchLoadRelations(withLineItems, 'taxes', (ids) =>
    db.taxItems.findMany({
      where: { invoiceId: { in: ids } },
    }),
  );

  return withTaxes;
}

/**
 * Prefetch relations for bills (eager loading config)
 */
export async function prefetchForBill(billIds: string[], db: any) {
  const bills = await db.bills.findMany({
    where: { id: { in: billIds } },
  });

  const withLineItems = await batchLoadRelations(bills, 'lineItems', (ids) =>
    db.billLineItems.findMany({
      where: { billId: { in: ids } },
    }),
  );

  const withPayments = await batchLoadRelations(withLineItems, 'payments', (ids) =>
    db.billPayments.findMany({
      where: { billId: { in: ids } },
    }),
  );

  return withPayments;
}

/**
 * Query performance timer
 */
export async function timeQuery<T>(
  name: string,
  query: Promise<T>,
  threshold: number = 100,
): Promise<T> {
  const startTime = Date.now();
  const result = await query;
  const duration = Date.now() - startTime;

  if (duration > threshold) {
    console.warn(`⚠️  SLOW QUERY [${name}]: ${duration}ms (threshold: ${threshold}ms)`);
  } else if (duration > threshold * 0.7) {
    console.log(`⏱️  Query [${name}]: ${duration}ms`);
  }

  return result;
}

/**
 * Recommend indexes for better performance
 */
export function recommendIndexes(): string[] {
  return [
    // Multi-column indexes for common filters
    'CREATE INDEX IF NOT EXISTS idx_invoices_org_status ON invoices(organization_id, status);',
    'CREATE INDEX IF NOT EXISTS idx_bills_org_status ON bills(organization_id, status);',
    'CREATE INDEX IF NOT EXISTS idx_journal_org_date ON journal_entries(organization_id, entry_date DESC);',
    'CREATE INDEX IF NOT EXISTS idx_bank_txn_org_status ON bank_transactions(organization_id, status);',
    'CREATE INDEX IF NOT EXISTS idx_gl_postings_account ON gl_postings(organization_id, account_code);',

    // Partial indexes (only active records)
    'CREATE INDEX IF NOT EXISTS idx_invoices_active ON invoices(organization_id, invoice_date DESC) WHERE status != \'CANCELLED\';',
    'CREATE INDEX IF NOT EXISTS idx_bills_active ON bills(organization_id, bill_date DESC) WHERE status != \'CANCELLED\';',

    // Text search indexes (if using PostgreSQL full-text search)
    'CREATE INDEX IF NOT EXISTS idx_invoices_search ON invoices USING gin(to_tsvector(\'english\', invoice_number || \' \' || COALESCE(customer_name, \'\')));',

    // Foreign key indexes (prevent sequential scans on joins)
    'CREATE INDEX IF NOT EXISTS idx_line_items_invoice ON line_items(invoice_id);',
    'CREATE INDEX IF NOT EXISTS idx_line_items_account ON line_items(account_code);',
    'CREATE INDEX IF NOT EXISTS idx_bill_items_bill ON bill_items(bill_id);',

    // Date range indexes
    'CREATE INDEX IF NOT EXISTS idx_invoices_date_range ON invoices(organization_id, invoice_date);',
    'CREATE INDEX IF NOT EXISTS idx_expenses_date_range ON expenses(organization_id, expense_date);',

    // Composite indexes for common WHERE + ORDER BY patterns
    'CREATE INDEX IF NOT EXISTS idx_bank_txn_date ON bank_transactions(organization_id, transaction_date DESC);',
    'CREATE INDEX IF NOT EXISTS idx_journal_entries_account ON journal_entries(organization_id, account_code, entry_date DESC);',
  ];
}

/**
 * Get database index statistics
 */
export async function getIndexStats(db: any) {
  return db.raw(`
    SELECT
      schemaname,
      tablename,
      indexname,
      idx_scan AS scans,
      idx_tup_read AS tuples_read,
      idx_tup_fetch AS tuples_fetched,
      pg_size_pretty(pg_relation_size(indexrelid)) AS size
    FROM pg_stat_user_indexes
    ORDER BY idx_scan DESC;
  `);
}

/**
 * Find unused indexes
 */
export async function findUnusedIndexes(db: any) {
  return db.raw(`
    SELECT
      schemaname,
      tablename,
      indexname,
      idx_scan,
      pg_size_pretty(pg_relation_size(indexrelid)) AS size
    FROM pg_stat_user_indexes
    WHERE idx_scan = 0
    AND indexname NOT LIKE 'pg_toast%'
    ORDER BY pg_relation_size(indexrelid) DESC;
  `);
}

/**
 * Get query execution plan (EXPLAIN)
 */
export async function explainQuery(db: any, query: string) {
  const result = await db.raw(`EXPLAIN ANALYZE ${query}`);
  return result.rows;
}

/**
 * Optimize table (VACUUM + ANALYZE)
 */
export async function optimizeTable(db: any, tableName: string) {
  console.log(`🔧 Optimizing table: ${tableName}...`);

  // VACUUM: Removes dead rows and reclaims space
  await db.raw(`VACUUM ANALYZE ${tableName}`);

  console.log(`✅ Table ${tableName} optimized`);
}

/**
 * Get slow queries from logs
 */
export async function getSlowQueries(
  db: any,
  threshold: number = 100,
): Promise<Array<{ query: string; calls: number; total_time: number; mean_time: number }>> {
  // Requires pg_stat_statements extension to be enabled
  try {
    return await db.raw(`
      SELECT
        query,
        calls,
        total_time,
        mean_time
      FROM pg_stat_statements
      WHERE mean_time > ?
      ORDER BY total_time DESC
      LIMIT 20;
    `, [threshold]);
  } catch (error) {
    console.warn('pg_stat_statements extension not enabled. Install with: CREATE EXTENSION pg_stat_statements;');
    return [];
  }
}

/**
 * Connection pool statistics
 */
export async function getConnectionPoolStats(db: any) {
  return {
    totalConnections: db.pool.totalCount,
    activeConnections: db.pool.totalCount - db.pool.idleCount,
    idleConnections: db.pool.idleCount,
    waitingRequests: (db.pool as any).waitingCount || 0,
  };
}

export default {
  paginate,
  cursorPaginate,
  batchLoadRelations,
  prefetchForInvoice,
  prefetchForBill,
  timeQuery,
  recommendIndexes,
  getIndexStats,
  findUnusedIndexes,
  explainQuery,
  optimizeTable,
  getSlowQueries,
  getConnectionPoolStats,
};
