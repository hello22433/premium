import { Injectable, Logger, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface Response<T> {
  result: T;
}

@Injectable()
export class TransformResInterceptor<T> implements NestInterceptor<T, Response<T>> {
  private readonly logger = new Logger('TransformResInterceptor');

  intercept(context: ExecutionContext, next: CallHandler): Observable<Response<T>> {
    const req = context.switchToHttp().getRequest();
    const url: string = req?.originalUrl ?? '';
    const isExternal = url.startsWith('/api/v1/external');
    return next.handle().pipe(
      map((result) => {
        if (isExternal) {
          const keys = result && typeof result === 'object' ? Object.keys(result as object).join(',') : 'n/a';
          this.logger.warn(
            `[DEBUG] transform map url=${url} resultType=${typeof result} ` +
              `ctor=${(result as any)?.constructor?.name} keys=${keys}`,
          );
        }
        return { result: result };
      }),
    );
  }
}
