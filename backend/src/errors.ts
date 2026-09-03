export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
  }
}
