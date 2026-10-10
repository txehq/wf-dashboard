// 带状态码的请求错误：页面据此区分"还不存在"（404）与其他错误
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export const isNotFound = (error: unknown) => error instanceof HttpError && error.status === 404;

// 全部页面请求共用：先看状态码再读正文。错误信息带 URL 与状态码，再加上服务端给出的原因：
// 路由中抛出的错误由 Fastify 返回 { statusCode, error, message }，原文在 message；路由自己返回 { error } 或 { message }；
// 服务端没有运行时 Vite 代理返回空正文或纯文本的 502，原样附上
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
    `${url} 返回 ${String(response.status)}${reason === '' ? '' : `：${reason}`}`,
    response.status,
  );
}

// 成功的响应：JSON 正文按 JSON 读，其余按文本读
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
