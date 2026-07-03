/** Response body of `GET /health` on the backend. */
export interface HealthResponse {
  status: 'ok';
  /** Package version of the backend. */
  version: string;
  /** Full git sha the running image was built from, or 'unknown' outside CI. */
  gitSha: string;
}
