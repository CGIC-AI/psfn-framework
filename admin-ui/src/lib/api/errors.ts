export class ApiError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    public body?: string,
  ) {
    super(`${status} ${statusText}`);
  }
}
