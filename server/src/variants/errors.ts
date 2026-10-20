// 带 HTTP 状态码的错误；Fastify 按 statusCode 返回响应
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
