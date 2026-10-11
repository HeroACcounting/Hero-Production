/**
 * Performance Monitoring Module
 * 
 * Features:
 * - Request response time tracking
 * - Slow query detection (> 100ms warn, > 500ms alert)
 * - Response compression middleware (gzip)
 * - Cache-control headers
 * - Query pattern analysis
 * - Performance metrics aggregation
 * 
 * Usage:
 * app.use(performanceMonitoringMiddleware);
 * const metrics = performanceMonitor.getMetrics();
 */

import { Request, Response, NextFunction } from 'express';
import { Injectable } from '@nestjs/common';
import * as compression from 'compression';

interface RequestMetric {
  method: string;
  path: string;
  statusCode: number;
  responseTime: number;
  timestamp: Date;
  queryCount?: number;
}

interface QueryMetric {
  pattern: string; // Normalized query pattern
  count: number;
  avgTime: number;
  maxTime: number;
  minTime: number;
}

interface PerformanceMetrics {
  avgResponseTime: number;
  maxResponseTime: number;
  minResponseTime: number;
  requestCount: number;
  slowRequestCount: number;
  slowRequests: RequestMetric[];
  topSlowPaths: Array<{ path: string; avgTime: number }>;
  cacheHitRate: string;
  compressionRate: string;
  queries: QueryMetric[];
}

@Injectable()
export class PerformanceMonitorService {
  private metrics: RequestMetric[] = [];
  private queryMetrics = new Map<string, QueryMetric>();
  private readonly maxMetricsSize = 1000;
  private compressionSize = 0;
  private originalSize = 0;

  /**
   * Record request metric
   */
  recordRequest(metric: RequestMetric) {
    this.metrics.push(metric);

    // Keep only last N requests to prevent memory leak
    if (this.metrics.length > this.maxMetricsSize) {
      this.metrics = this.metrics.slice(-this.maxMetricsSize);
    }

    // Log slow requests
    if (metric.responseTime > 1000) {
      console.warn(
        `⚠️  SLOW REQUEST: ${metric.method} ${metric.path} took ${metric.responseTime}ms`,
      );
    }
  }

  /**
   * Record query metric
   */
  recordQuery(queryPattern: string, executeTime: number) {
    const existing = this.queryMetrics.get(queryPattern);

    if (existing) {
      existing.count++;
      existing.avgTime = (existing.avgTime * (existing.count - 1) + executeTime) / existing.count;
      existing.maxTime = Math.max(existing.maxTime, executeTime);
      existing.minTime = Math.min(existing.minTime, executeTime);
    } else {
      this.queryMetrics.set(queryPattern, {
        pattern: queryPattern,
        count: 1,
        avgTime: executeTime,
        maxTime: executeTime,
        minTime: executeTime,
      });
    }

    // Warn on slow queries
    if (executeTime > 100) {
      console.warn(
        `⚠️  SLOW QUERY: ${queryPattern.substring(0, 80)}... took ${executeTime}ms`,
      );
    }
  }

  /**
   * Get aggregated performance metrics
   */
  getMetrics(): PerformanceMetrics {
    if (this.metrics.length === 0) {
      return {
        avgResponseTime: 0,
        maxResponseTime: 0,
        minResponseTime: 0,
        requestCount: 0,
        slowRequestCount: 0,
        slowRequests: [],
        topSlowPaths: [],
        cacheHitRate: '0%',
        compressionRate: '0%',
        queries: [],
      };
    }

    const responseTimes = this.metrics.map((m) => m.responseTime);
    const avgResponseTime = responseTimes.reduce((a, b) => a + b) / responseTimes.length;
    const slowRequests = this.metrics.filter((m) => m.responseTime > 500);

    // Top slow paths
    const pathTimes = new Map<string, number[]>();
    this.metrics.forEach((m) => {
      if (!pathTimes.has(m.path)) {
        pathTimes.set(m.path, []);
      }
      pathTimes.get(m.path)!.push(m.responseTime);
    });

    const topSlowPaths = Array.from(pathTimes.entries())
      .map(([path, times]) => ({
        path,
        avgTime: times.reduce((a, b) => a + b) / times.length,
      }))
      .sort((a, b) => b.avgTime - a.avgTime)
      .slice(0, 5);

    // Compression rate
    const compressionRate =
      this.originalSize > 0
        ? ((1 - this.compressionSize / this.originalSize) * 100).toFixed(1)
        : '0';

    return {
      avgResponseTime: Math.round(avgResponseTime),
      maxResponseTime: Math.max(...responseTimes),
      minResponseTime: Math.min(...responseTimes),
      requestCount: this.metrics.length,
      slowRequestCount: slowRequests.length,
      slowRequests: slowRequests.slice(-10), // Last 10 slow requests
      topSlowPaths,
      cacheHitRate: this.calculateCacheHitRate(),
      compressionRate: `${compressionRate}%`,
      queries: Array.from(this.queryMetrics.values())
        .sort((a, b) => b.avgTime - a.avgTime)
        .slice(0, 10),
    };
  }

  /**
   * Record compression metrics
   */
  recordCompression(originalSize: number, compressedSize: number) {
    this.originalSize += originalSize;
    this.compressionSize += compressedSize;
  }

  /**
   * Calculate cache hit rate (from Last-Modified headers)
   */
  private calculateCacheHitRate(): string {
    if (this.metrics.length === 0) return '0%';

    const cached = this.metrics.filter((m) => m.statusCode === 304).length;
    const rate = ((cached / this.metrics.length) * 100).toFixed(1);
    return `${rate}%`;
  }

  /**
   * Reset metrics
   */
  reset() {
    this.metrics = [];
    this.queryMetrics.clear();
    this.compressionSize = 0;
    this.originalSize = 0;
  }
}

/**
 * Global performance monitor instance
 */
const performanceMonitor = new PerformanceMonitorService();

/**
 * Express middleware for request performance tracking
 */
export function createPerformanceMonitoringMiddleware(monitor: PerformanceMonitorService) {
  return (req: Request, res: Response, next: NextFunction) => {
    const startTime = Date.now();

    // Monkey-patch res.json to track compression
    const originalJson = res.json.bind(res);
    res.json = function (data: any) {
      const originalSize = JSON.stringify(data).length;
      const responseTime = Date.now() - startTime;

      // Record metric
      monitor.recordRequest({
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        responseTime,
        timestamp: new Date(),
      });

      // Log metric
      if (responseTime > 500) {
        console.log(
          `📊 ${req.method.padEnd(6)} ${req.path.padEnd(40)} ${res.statusCode} - ${responseTime}ms`,
        );
      }

      return originalJson(data);
    };

    next();
  };
}

/**
 * Get compression middleware with optimal settings
 * 
 * Settings:
 * - Level 6: Balance between CPU usage and compression ratio
 * - Threshold 1KB: Don't compress responses < 1KB
 * - Filter: Compress JSON, text, JavaScript
 */
export function getCompressionMiddleware() {
  return compression({
    level: 6,
    threshold: 1024, // 1KB
    filter: (req: Request, res: Response) => {
      // Don't compress if client doesn't support it
      if (req.headers['x-no-compression']) {
        return false;
      }

      // Compress only these types
      const contentType = res.getHeader('content-type')?.toString() || '';
      return /json|text|javascript/.test(contentType);
    },
  });
}

/**
 * Cache control middleware
 * Sets appropriate cache headers for different endpoints
 */
export function getCacheControlMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const path = req.path;

    // Static assets: 1 hour
    if (/\.(js|css|woff|woff2|png|jpg|jpeg|gif|svg)$/.test(path)) {
      res.set('Cache-Control', 'public, max-age=3600, immutable');
      return next();
    }

    // Lookup tables (countries, currencies): 5 minutes
    if (/\/api\/v1\/(countries|currencies|categories)/.test(path)) {
      res.set('Cache-Control', 'public, max-age=300');
      return next();
    }

    // User data: No cache (always fresh)
    if (/\/api\/v1\/(dashboard|invoices|bills|accounts)/.test(path)) {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.set('Pragma', 'no-cache');
      res.set('Expires', '0');
      return next();
    }

    // Default: 1 minute
    res.set('Cache-Control', 'public, max-age=60');
    next();
  };
}

/**
 * Query analyzer for detecting N+1 problems
 */
export class QueryPerformanceAnalyzer {
  private queryLog: Array<{ query: string; time: number; stack: string }> = [];

  /**
   * Log a query execution
   */
  logQuery(query: string, executeTime: number, stack?: string) {
    this.queryLog.push({
      query: this.normalizeQuery(query),
      time: executeTime,
      stack: stack || '',
    });
  }

  /**
   * Normalize query to detect patterns (for grouping similar queries)
   * Example: SELECT * FROM users WHERE id = 1 -> SELECT * FROM users WHERE id = ?
   */
  private normalizeQuery(query: string): string {
    return query
      .replace(/\d+/g, '?') // Replace numbers with ?
      .replace(/\$\d+/g, '?') // Replace $1, $2, etc with ?
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim();
  }

  /**
   * Detect potential N+1 queries
   * Returns queries that are executed many times with different parameters
   */
  detectNPlusOne(): Array<{ pattern: string; count: number; avgTime: number }> {
    const patternMap = new Map<string, { count: number; times: number[] }>();

    this.queryLog.forEach(({ query, time }) => {
      const normalized = query;
      if (!patternMap.has(normalized)) {
        patternMap.set(normalized, { count: 0, times: [] });
      }
      const entry = patternMap.get(normalized)!;
      entry.count++;
      entry.times.push(time);
    });

    // Return patterns executed more than 5 times
    return Array.from(patternMap.entries())
      .filter(([_, { count }]) => count > 5)
      .map(([pattern, { count, times }]) => ({
        pattern,
        count,
        avgTime: times.reduce((a, b) => a + b) / times.length,
      }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Get slow query report
   */
  getSlowQueryReport(threshold: number = 100) {
    return this.queryLog
      .filter(({ time }) => time > threshold)
      .sort((a, b) => b.time - a.time)
      .slice(0, 20);
  }

  /**
   * Reset query log
   */
  reset() {
    this.queryLog = [];
  }
}

// Health check endpoint setup (for NestJS)
export async function setupHealthCheckEndpoint(app: any) {
  app.get('/health/performance', (req: Request, res: Response) => {
    const metrics = performanceMonitor.getMetrics();
    res.json(metrics);
  });

  app.get('/metrics/performance', (req: Request, res: Response) => {
    const metrics = performanceMonitor.getMetrics();
    const status = metrics.avgResponseTime < 300 ? 'healthy' : 'degraded';
    res.json({ status, ...metrics });
  });

  console.log('✅ Performance monitoring endpoints registered');
}

export { performanceMonitor, PerformanceMonitorService };
