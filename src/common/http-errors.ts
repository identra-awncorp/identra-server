import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';

// The parts of Express's response used here (the server has no @types/express).
export interface HttpResponse {
  status(code: number): { json(body: unknown): void };
  setHeader(name: string, value: string): void;
  removeHeader(name: string): void;
}

const logger = new Logger('HttpErrors');

/** Stable codes of docs/vc-api.md §2, by HTTP status, for exceptions that do not name one. */
const V1_CODES: Record<number, string> = {
  400: 'VALIDATION_FAILED',
  401: 'INVALID_CREDENTIALS',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'VALIDATION_FAILED',
  429: 'RATE_LIMITED',
  503: 'UNAVAILABLE'
};

/** Throw from a /v1 route of docs/vc-api.md: rendered as `{ statusCode, code, message }`. */
export function apiError(status: number, code: string, message: string): HttpException {
  return new HttpException({ code, message }, status);
}

function describe(exception: HttpException): { code?: string; message: string } {
  const body = exception.getResponse();

  if (typeof body === 'string') return { message: body };

  const { code, message } = body as { code?: unknown; message?: unknown };

  return {
    code: typeof code === 'string' ? code : undefined,
    message: Array.isArray(message) ? message.join('; ') : typeof message === 'string' ? message : exception.message
  };
}

// Unknown errors are logged by type only: messages of driver errors can carry query values.
function logUnexpected(exception: unknown): void {
  const name = exception instanceof Error ? exception.name : typeof exception;
  const code = (exception as { code?: unknown })?.code;

  logger.error(`Unhandled ${name}${typeof code === 'string' ? ` (${code})` : ''}`);
}

/**
 * Error envelope `{ statusCode, code, message }` for the /v1 routes of docs/vc-api.md (the older
 * auth routes keep their own shape). Use with @UseFilters on those controllers.
 */
@Catch()
export class V1ErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<HttpResponse>();

    if (!(exception instanceof HttpException)) {
      logUnexpected(exception);
      res.status(500).json({ statusCode: 500, code: 'INTERNAL_ERROR', message: 'Internal server error' });

      return;
    }

    const statusCode = exception.getStatus();
    const { code, message } = describe(exception);

    res.status(statusCode).json({
      statusCode,
      code: exception instanceof ThrottlerException ? 'RATE_LIMITED' : (code ?? V1_CODES[statusCode] ?? 'ERROR'),
      message: statusCode >= 500 ? 'Service unavailable' : message
    });
  }
}

/** For protocol routes: an OAuth 2.0 error code chosen by the controller. */
export function oauthError(status: number, error: string, description: string): HttpException {
  return new HttpException({ error, error_description: description }, status);
}

/**
 * OAuth 2.0 style errors `{ error, error_description }` for the unprefixed protocol routes
 * (OpenID4VCI / OpenID4VP and the signed public resources). Never a stack trace; anything
 * unexpected is `server_error`.
 */
@Catch()
export class ProtocolErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<HttpResponse>();

    if (!(exception instanceof HttpException)) {
      logUnexpected(exception);
      res.status(500).json({ error: 'server_error' });

      return;
    }

    const status = exception.getStatus();
    const body = exception.getResponse() as { error?: unknown; error_description?: unknown };

    // Thrown with oauthError(): Nest's own exceptions also carry `error` ("Not Found"), not an OAuth code.
    if (typeof body === 'object' && typeof body.error === 'string' && 'error_description' in body) {
      res.status(status).json({ error: body.error, error_description: String(body.error_description ?? '') });

      return;
    }

    const error =
      status === HttpStatus.TOO_MANY_REQUESTS || status === HttpStatus.SERVICE_UNAVAILABLE
        ? 'temporarily_unavailable'
        : status === HttpStatus.NOT_FOUND
          ? 'not_found'
          : status >= 500
            ? 'server_error'
            : 'invalid_request';

    res.status(status >= 500 && status !== 503 ? 500 : status).json({
      error,
      error_description: status >= 500 ? 'Server error' : describe(exception).message
    });
  }
}

/**
 * Public signed resources (trust list, status lists, issuer metadata): readable from any origin,
 * never with credentials (docs/vc-api.md §2). Overrides what the global CORS middleware set.
 */
export function allowAnyOrigin(res: HttpResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Date lets a page warn about a wrong device clock (docs/vc-api.md §2).
  res.setHeader('Access-Control-Expose-Headers', 'Date, Retry-After');
  res.removeHeader('Access-Control-Allow-Credentials');
  res.removeHeader('Vary');
}
