// Request error with a status code: pages use it to tell "does not exist yet" (404) from other errors; reason is the server's reason (empty when none)
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason: string,
  ) {
    super(message);
  }
}

export const isNotFound = (error: unknown) => error instanceof HttpError && error.status === 404;

// Shared by all page requests: check the status before reading the body. The error message has the URL and status, plus the server's reason:
// errors thrown in a route come back from Fastify as { statusCode, error, message } with the text in message; routes themselves return { error } or { message };
// when the server is not running, the Vite proxy returns a 502 with an empty or plain text body, attached as is
export async function responseError(response: Response, url: string): Promise<HttpError> {
  const text = (await response.text()).trim();
  const json = response.headers.get('content-type')?.includes('application/json') === true;
  const body =
    json && text !== '' ? (JSON.parse(text) as { message?: unknown; error?: unknown }) : null;
  const reason =
    body === null
      ? text
      : typeof body.message === 'string'
        ? body.message
        : typeof body.error === 'string'
          ? body.error
          : text;
  return new HttpError(
    `${url} returned ${String(response.status)}${reason === '' ? '' : `: ${reason}`}`,
    response.status,
    reason,
  );
}

// A successful response: a JSON body is read as JSON, anything else as text
export async function readBody(response: Response, url: string): Promise<unknown> {
  if (!response.ok) throw await responseError(response, url);
  const json = response.headers.get('content-type')?.includes('application/json') === true;
  return json ? response.json() : response.text();
}

export async function requestJson(method: string, url: string, body?: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return readBody(response, url);
}
