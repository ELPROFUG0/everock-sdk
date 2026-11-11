/**
 * Captures errors thrown by route handlers, then rethrows so Nest's own
 * exception handling runs untouched — we observe, we don't interfere.
 */
import { Injectable, type NestInterceptor, type ExecutionContext, type CallHandler } from '@nestjs/common';
import { type Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { captureError } from '@everock/sdk/node';

@Injectable()
export class EverockInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((err) => {
        captureError(err, undefined, { handled: false, mechanism: 'framework_error' });
        return throwError(() => err);
      }),
    );
  }
}
