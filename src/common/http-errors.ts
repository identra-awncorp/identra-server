import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger, ServiceUnavailableException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { ThrottlerException } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';

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
  413: 'PAYLOAD_TOO_LARGE',
  429: 'RATE_LIMITED',
  503: 'UNAVAILABLE'
};

/** Throw from a /v1 route of docs/vc-api.md: rendered as `{ statusCode, code, message }`. */
export function apiError(
  status: number,
  code: string,
  message: string,
  options: { retryAfter?: number; details?: { reason?: string; index?: number | null } } = {}
): HttpException {
  return Object.assign(new HttpException({ code, message, ...options.details }, status), { retryAfter: options.retryAfter });
}

/** 503 UNAVAILABLE with `Retry-After`: a dependency (Redis, a lock, the pool) is busy or down. */
export const unavailable = (message = 'Temporarily unavailable; try again shortly.') =>
  apiError(503, 'UNAVAILABLE', message, { retryAfter: 1 });

function describe(exception: HttpException): { code?: string; message: string } {
  const body = exception.getResponse();

  if (typeof body === 'string') return { message: body };

  const { code, message } = body as { code?: unknown; message?: unknown };

  return {
    code: typeof code === 'string' ? code : undefined,
    message: Array.isArray(message) ? message.join('; ') : typeof message === 'string' ? message : exception.message
  };
}

/** Seconds a client waits after a dependency (Postgres, Redis) was found down. */
const DEPENDENCY_RETRY_AFTER = 5;
// Unreachable, timed out, closed by the server, pool exhausted, too many connections.
const PRISMA_UNREACHABLE = ['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2037'];
// What the engine reports, as an unknown request error, when Postgres goes away mid-query: SQLSTATE
// class 08 (connection exception), 57P01–57P03 (shut down, restarting), 53300 (too many
// connections), or a closed connection. A SQLSTATE counts only where the engine writes one
// (`code: "57P01"` in its debug form, ``Code: `57P01` `` in its message), never a bare match:
// "order 08abc" or the "-08T" of a date are not a lost connection. Any other unknown error (a
// failing trigger) stays a 500.
const POSTGRES_GONE = /\bcode: ?(["`])(08[0-9A-Z]{3}|57P0[1-3]|53300)\1|kind: Closed|terminating connection|server closed the connection/i;
// ioredis messages, and the replies of a Redis that cannot write (disk: MISCONF), is still loading
// its data after a restart (LOADING) or is a replica (READONLY).
const REDIS_UNREACHABLE = /^(Command timed out|Connection is closed\.|Stream isn't writeable|OOM command not allowed|MISCONF |LOADING |READONLY )/;

/**
 * Postgres or Redis unreachable, timing out, full or not writable: the request cannot be served
 * now, which is a 503 with Retry-After, never a 500. ioredis: MaxRetriesPerRequestError, the
 * command timeout, a closed connection, OOM under `noeviction`, MISCONF, LOADING, READONLY;
 * Prisma: initialisation errors, the connection-class codes above, and unknown request errors
 * that say Postgres went away (POSTGRES_GONE).
 */
export function isDependencyDown(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientInitializationError) return true;
  if (error instanceof Prisma.PrismaClientUnknownRequestError) return POSTGRES_GONE.test(error.message);
  if (error instanceof Prisma.PrismaClientKnownRequestError) return PRISMA_UNREACHABLE.includes(error.code);
  if (!(error instanceof Error)) return false;

  return error.name === 'MaxRetriesPerRequestError' || REDIS_UNREACHABLE.test(error.message) || (error as { code?: unknown }).code === 'ECONNREFUSED';
}

function logDependencyDown(exception: unknown): void {
  const name = exception instanceof Error ? exception.name : typeof exception;
  const code = (exception as { code?: unknown })?.code;

  logger.warn(`Dependency unavailable: ${name}${typeof code === 'string' ? ` (${code})` : ''}`);
}

const TOO_MANY_REQUESTS = 'Too many requests; try again later.';

// Unknown errors are logged by type only: messages of driver errors can carry query values.
function logUnexpected(exception: unknown): void {
  const name = exception instanceof Error ? exception.name : typeof exception;
  const code = (exception as { code?: unknown })?.code;

  logger.error(`Unhandled ${name}${typeof code === 'string' ? ` (${code})` : ''}`);
}

function renderV1(exception: unknown, res: HttpResponse): void {
  if (isDependencyDown(exception)) {
    logDependencyDown(exception);
    res.setHeader('Retry-After', String(DEPENDENCY_RETRY_AFTER));
    res.status(503).json({ statusCode: 503, code: 'UNAVAILABLE', message: 'Service unavailable' });

    return;
  }

  if (!(exception instanceof HttpException)) {
    logUnexpected(exception);
    res.status(500).json({ statusCode: 500, code: 'INTERNAL_ERROR', message: 'Internal server error' });

    return;
  }

  const statusCode = exception.getStatus();
  const { code, message } = describe(exception);
  // Optional machine-readable detail of a refusal (e.g. the SDK code of a product event).
  const { reason, index } = (typeof exception.getResponse() === 'object' ? exception.getResponse() : {}) as { reason?: unknown; index?: unknown };
  const retryAfter = (exception as { retryAfter?: unknown }).retryAfter;

  if (typeof retryAfter === 'number') res.setHeader('Retry-After', String(retryAfter));
  else if (statusCode === 503) res.setHeader('Retry-After', '1');

  res.status(statusCode).json({
    statusCode,
    // The contract has one code per 503 (e.g. the rate limiter's own RATE_LIMIT_UNAVAILABLE).
    code:
      exception instanceof ThrottlerException
        ? 'RATE_LIMITED'
        : statusCode === 503
          ? 'UNAVAILABLE'
          : (code ?? V1_CODES[statusCode] ?? 'ERROR'),
    message: statusCode >= 500 ? 'Service unavailable' : exception instanceof ThrottlerException ? TOO_MANY_REQUESTS : message,
    ...(typeof reason === 'string' ? { reason } : {}),
    ...(typeof index === 'number' || index === null ? { index } : {})
  });
}

/** Error envelope `{ statusCode, code, message }` for the /v1 routes of docs/vc-api.md. */
@Catch()
export class V1ErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    renderV1(exception, host.switchToHttp().getResponse<HttpResponse>());
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
    renderProtocol(exception, host.switchToHttp().getResponse<HttpResponse>());
  }
}

function renderProtocol(exception: unknown, res: HttpResponse): void {
  if (isDependencyDown(exception)) {
    logDependencyDown(exception);
    res.setHeader('Retry-After', String(DEPENDENCY_RETRY_AFTER));
    res.status(503).json({ error: 'temporarily_unavailable', error_description: 'Service unavailable' });

    return;
  }

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
    error_description: status >= 500 ? 'Server error' : exception instanceof ThrottlerException ? TOO_MANY_REQUESTS : describe(exception).message
  });
}

/** Paths of the unprefixed protocol routes (docs/vc-api.md §3, §4, §6). */
const PROTOCOL_PATH = /^\/(\.well-known|issuers|oid4vp|trust-list)(\/|$)/;
type Shape = 'protocol' | 'v1' | 'default';

/** Which error shape a path gets; the auth routes keep Nest's own shape (docs/auth-flow.md). */
export function errorShapeOf(path: string): Shape {
  if (PROTOCOL_PATH.test(path)) return 'protocol';
  if (path.startsWith('/v1/') && !path.startsWith('/v1/auth/')) return 'v1';

  return 'default';
}

/**
 * Global fallback, so even errors no controller filter sees (unknown paths, guards of routes
 * without a filter) get the right shape: OAuth on protocol paths, the envelope under /v1.
 * GraphQL errors pass through untouched.
 */
@Catch()
export class RoutedErrorFilter extends BaseExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception;

    const http = host.switchToHttp();
    const path = (http.getRequest<{ path?: string }>().path ?? '').split('?')[0]!;
    const shape = errorShapeOf(path);

    if (shape === 'protocol') return renderProtocol(exception, http.getResponse<HttpResponse>());
    if (shape === 'v1') return renderV1(exception, http.getResponse<HttpResponse>());

    if (isDependencyDown(exception)) {
      logDependencyDown(exception);
      http.getResponse<HttpResponse>().setHeader('Retry-After', String(DEPENDENCY_RETRY_AFTER));

      return super.catch(new ServiceUnavailableException(), host);
    }

    super.catch(exception, host);
  }
}

/**
 * Express error handler right after the body parsers: malformed JSON, oversized or badly
 * encoded bodies never reach Nest, so they are rendered here (never the parser's message).
 */
export function bodyParserErrorHandler(
  error: { status?: number; type?: string },
  req: { path?: string },
  res: HttpResponse,
  next: (error?: unknown) => void
): void {
  const status = error?.status === 413 ? 413 : error?.status === 400 || error?.status === 415 ? error.status : undefined;
  const shape = errorShapeOf(req.path ?? '');

  if (status === undefined || shape === 'default') return next(error);

  if (shape === 'protocol') {
    res.status(status).json({ error: 'invalid_request', error_description: status === 413 ? 'the request body is too large' : 'the request body is malformed' });
  } else {
    res.status(status).json({
      statusCode: status,
      code: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'VALIDATION_FAILED',
      message: status === 413 ? 'The request body is too large.' : 'The request body is malformed.'
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
