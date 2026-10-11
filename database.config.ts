/**
 * Database Configuration Module
 * 
 * Features:
 * - Connection pooling with configurable limits
 * - Exponential backoff retry logic (5 attempts: 1s, 2s, 4s, 8s, 16s)
 * - Tenant-aware GUC setting for row-level security
 * - Health check endpoint
 * - Graceful shutdown handlers
 * - Environment-based configuration (DATABASE_URL or individual vars)
 * 
 * Usage:
 * const { getDatabase, testConnection, getPoolStatus } = await getDatabaseConfig();
 */

import { Pool, Client, QueryResult } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  max: number; // max pool size
  min: number; // min pool size
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
}

interface PoolStatus {
  totalConnections: number;
  activeConnections: number;
  idleConnections: number;
  waitingRequests: number;
  isHealthy: boolean;
}

interface HealthCheckResult {
  status: 'healthy' | 'degraded' | 'unhealthy';
  responseTime: number;
  poolStatus: PoolStatus;
  timestamp: string;
  details: string;
}

/**
 * Parse database URL or use individual environment variables
 */
function parseDatabaseConfig(): DatabaseConfig {
  const databaseUrl = process.env.DATABASE_URL;

  if (databaseUrl) {
    // Parse postgresql://user:password@host:port/database format
    const url = new URL(databaseUrl);
    return {
      host: url.hostname || 'localhost',
      port: parseInt(url.port || '5432'),
      user: url.username || 'postgres',
      password: url.password || '',
      database: url.pathname.slice(1) || 'postgres',
      max: parseInt(process.env.DB_POOL_MAX || '20'),
      min: parseInt(process.env.DB_POOL_MIN || '5'),
      idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT || '30000'),
      connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT || '10000'),
    };
  }

  // Fall back to individual environment variables
  return {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'hero_accounting',
    max: parseInt(process.env.DB_POOL_MAX || '20'),
    min: parseInt(process.env.DB_POOL_MIN || '5'),
    idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT || '30000'),
    connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT || '10000'),
  };
}

/**
 * Exponential backoff retry logic
 * Attempts: 1s, 2s, 4s, 8s, 16s (total: 31 seconds)
 */
async function withRetry<T>(
  operation: () => Promise<T>,
  operationName: string,
  maxAttempts: number = 5,
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`[${operationName}] Attempt ${attempt}/${maxAttempts}`);
      return await operation();
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxAttempts) {
        const delayMs = Math.pow(2, attempt - 1) * 1000;
        console.warn(
          `[${operationName}] Attempt ${attempt} failed: ${lastError.message}. Retrying in ${delayMs}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw new Error(
    `[${operationName}] All ${maxAttempts} attempts failed: ${lastError?.message}`,
  );
}

/**
 * Global pool instance
 */
let globalPool: Pool | null = null;

/**
 * Initialize database connection pool with retry logic
 */
export async function initializeDatabasePool(): Promise<Pool> {
  if (globalPool) {
    return globalPool;
  }

  const config = parseDatabaseConfig();

  globalPool = new Pool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    max: config.max,
    min: config.min,
    idleTimeoutMillis: config.idleTimeoutMillis,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
  });

  // Test connection with retry
  await withRetry(
    async () => {
      const client = await globalPool!.connect();
      try {
        const result = await client.query('SELECT NOW()');
        console.log('✅ Database connection successful:', result.rows[0]);
      } finally {
        client.release();
      }
    },
    'Database Connection',
  );

  // Set up graceful shutdown
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  return globalPool;
}

/**
 * Get database pool instance
 */
export function getDatabase(): Pool {
  if (!globalPool) {
    throw new Error('Database pool not initialized. Call initializeDatabasePool() first.');
  }
  return globalPool;
}

/**
 * Test database connection
 */
export async function testDatabaseConnection(): Promise<boolean> {
  try {
    const pool = getDatabase();
    const client = await pool.connect();
    try {
      const result = await client.query('SELECT NOW()');
      console.log('✅ Database connection test passed');
      return true;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('❌ Database connection test failed:', error);
    return false;
  }
}

/**
 * Get pool status information
 */
export function getPoolStatus(): PoolStatus {
  const pool = getDatabase();
  const totalConnections = pool.totalCount;
  const idleConnections = pool.idleCount;
  const activeConnections = totalConnections - idleConnections;
  const waitingRequests = (pool as any).waitingCount || 0;

  return {
    totalConnections,
    activeConnections,
    idleConnections,
    waitingRequests,
    isHealthy: activeConnections < (pool as any).options.max * 0.8,
  };
}

/**
 * Health check with detailed status
 */
export async function healthCheck(): Promise<HealthCheckResult> {
  const startTime = Date.now();

  try {
    const pool = getDatabase();
    const client = await pool.connect();

    try {
      await client.query('SELECT 1');
    } finally {
      client.release();
    }

    const responseTime = Date.now() - startTime;
    const poolStatus = getPoolStatus();

    const status: 'healthy' | 'degraded' | 'unhealthy' =
      responseTime < 100 && poolStatus.isHealthy
        ? 'healthy'
        : responseTime < 500
          ? 'degraded'
          : 'unhealthy';

    return {
      status,
      responseTime,
      poolStatus,
      timestamp: new Date().toISOString(),
      details: `Connection time: ${responseTime}ms, Active connections: ${poolStatus.activeConnections}/${poolStatus.totalConnections}`,
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    return {
      status: 'unhealthy',
      responseTime,
      poolStatus: {
        totalConnections: 0,
        activeConnections: 0,
        idleConnections: 0,
        waitingRequests: 0,
        isHealthy: false,
      },
      timestamp: new Date().toISOString(),
      details: `Connection failed: ${(error as Error).message}`,
    };
  }
}

/**
 * Execute query with tenant context
 * Useful for row-level security in multi-tenant setups
 */
export async function executeWithTenantContext(
  query: string,
  params: any[] = [],
  tenantId?: string,
): Promise<QueryResult> {
  const pool = getDatabase();
  const client = await pool.connect();

  try {
    // Set tenant context as PostgreSQL GUC (Grand Unified Config)
    if (tenantId) {
      await client.query(`SET app.current_tenant = '${tenantId}'`);
    }

    const result = await client.query(query, params);
    return result;
  } finally {
    client.release();
  }
}

/**
 * Graceful shutdown handler
 */
async function gracefulShutdown(signal: string) {
  console.log(`\n📍 Received ${signal}, gracefully shutting down...`);

  if (globalPool) {
    try {
      // Stop accepting new connections
      globalPool.ending = true;

      // Wait for existing connections to finish (max 30 seconds)
      const shutdownTimeout = setTimeout(() => {
        console.warn('⚠️  Shutdown timeout reached, force closing pool');
        process.exit(1);
      }, 30000);

      await globalPool.end();
      clearTimeout(shutdownTimeout);
      console.log('✅ Database pool closed successfully');
    } catch (error) {
      console.error('❌ Error during pool shutdown:', error);
      process.exit(1);
    }
  }

  process.exit(0);
}

/**
 * Get database statistics
 */
export async function getDatabaseStats() {
  const pool = getDatabase();
  const client = await pool.connect();

  try {
    const result = await client.query(`
      SELECT
        schemaname,
        tablename,
        pg_size_pretty(pg_total_relation_size(schemaname || '.' || tablename)) AS size,
        n_live_tup AS row_count
      FROM pg_stat_user_tables
      ORDER BY pg_total_relation_size(schemaname || '.' || tablename) DESC
      LIMIT 10;
    `);

    return result.rows;
  } finally {
    client.release();
  }
}

export default {
  initializeDatabasePool,
  getDatabase,
  testDatabaseConnection,
  getPoolStatus,
  healthCheck,
  executeWithTenantContext,
  getDatabaseStats,
};
