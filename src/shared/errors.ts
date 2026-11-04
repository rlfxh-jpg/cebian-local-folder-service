export class ServiceError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable = false) {
    super(message);
    this.name = "ServiceError";
  }
}

export function asServiceError(error: unknown): ServiceError {
  if (error instanceof ServiceError) return error;
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as NodeJS.ErrnoException).code);
    if (code === "ENOENT") return new ServiceError("NOT_FOUND", "目标不存在。");
    if (code === "EACCES" || code === "EPERM") return new ServiceError("PERMISSION_DENIED", "没有访问该目标的权限。");
    if (code === "EEXIST") return new ServiceError("ALREADY_EXISTS", "同名目标已存在。");
    if (code === "ENOTDIR") return new ServiceError("NOT_DIRECTORY", "目标不是目录。");
    if (code === "EMFILE" || code === "ENFILE") return new ServiceError("RESOURCE_LIMIT", "系统打开的文件过多，请稍后重试。", true);
  }
  return new ServiceError("INTERNAL_ERROR", "服务处理请求时发生错误。");
}
