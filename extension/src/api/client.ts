import type {
  GetBookmarksResponse,
  GetChecksumResponse,
  GetOpsResponse,
  PostOpsResponse,
  SyncOp,
} from '@nodefav/shared';

/** What the sync engine needs from the backend; `ApiClient` is the real thing. */
export interface SyncApi {
  postOps(ops: SyncOp[]): Promise<PostOpsResponse>;
  getOps(since: number, limit: number): Promise<GetOpsResponse>;
  getBookmarks(): Promise<GetBookmarksResponse>;
  getChecksum(): Promise<GetChecksumResponse>;
}

export interface ServerConfig {
  serverUrl: string;
  token: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const REQUEST_TIMEOUT_MS = 20_000;

export class ApiClient implements SyncApi {
  private baseUrl: string;
  private token: string;

  constructor(config: ServerConfig) {
    this.baseUrl = config.serverUrl.replace(/\/+$/, '');
    this.token = config.token;
  }

  postOps(ops: SyncOp[]): Promise<PostOpsResponse> {
    return this.request('POST', '/api/ops', { ops });
  }

  getOps(since: number, limit: number): Promise<GetOpsResponse> {
    return this.request('GET', `/api/ops?since=${since}&limit=${limit}`);
  }

  getBookmarks(): Promise<GetBookmarksResponse> {
    return this.request('GET', '/api/bookmarks');
  }

  getChecksum(): Promise<GetChecksumResponse> {
    return this.request('GET', '/api/checksum');
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ApiError(
        `${method} ${path} → ${response.status} ${text.slice(0, 200)}`,
        response.status,
      );
    }
    return (await response.json()) as T;
  }
}
