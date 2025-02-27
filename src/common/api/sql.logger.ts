import { Logger } from 'typeorm';
import { highlight } from 'cli-highlight';
import { format } from 'sql-formatter';

export class SqlLogger implements Logger {
  logQuery(query: string, parameters?: any[]) {
    const formattedQuery = format(query);
    const highlightedQuery = highlight(formattedQuery, { language: 'sql', ignoreIllegals: true });
    console.log('[QUERY]:\n', highlightedQuery);

    if (parameters && parameters.length) {
      console.log('[PARAMETERS]:', parameters);
    }
  }

  logQueryError(error: string | Error, query: string, parameters?: any[]) {
    const formattedQuery = format(query);
    const highlightedQuery = highlight(formattedQuery, { language: 'sql', ignoreIllegals: true });

    console.error('[QUERY ERROR]:', error);
    console.error('[QUERY]:\n', highlightedQuery);

    if (parameters && parameters.length) {
      console.error('[PARAMETERS]:', parameters);
    }
  }

  logQuerySlow(time: number, query: string, parameters?: any[]) {
    const formattedQuery = format(query);
    const highlightedQuery = highlight(formattedQuery, { language: 'sql', ignoreIllegals: true });

    console.warn(`[SLOW QUERY - ${time} ms]:\n`, highlightedQuery);

    if (parameters && parameters.length) {
      console.warn('[PARAMETERS]:', parameters);
    }
  }

  logSchemaBuild(message: string) {
    console.log('[SCHEMA BUILD]:', message);
  }

  logMigration(message: string) {
    console.log('[MIGRATION]:', message);
  }

  log(level: 'log' | 'info' | 'warn', message: any) {
    if (level === 'log') console.log('[LOG]:', message);
    if (level === 'info') console.info('[INFO]:', message);
    if (level === 'warn') console.warn('[WARN]:', message);
  }
}
