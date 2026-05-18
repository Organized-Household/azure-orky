import { IncomingMessage, ServerResponse } from 'http';
import { getPool } from '../db/dbClient';

function sendJson(res: ServerResponse, statusCode: number, payload: Record<string, unknown>): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function checkAdminAuth(req: IncomingMessage, res: ServerResponse): boolean {
  const adminToken = process.env.ORKY_ADMIN_TOKEN;
  if (!adminToken) {
    sendJson(res, 503, { error: 'Admin API not configured — set ORKY_ADMIN_TOKEN' });
    return false;
  }
  const authHeader = req.headers['authorization'] ?? '';
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (provided !== adminToken) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return false;
  }
  return true;
}

export async function handleAdminApi(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  // Returns true if the request was handled (caller should return)
  // Returns false if the pathname does not match any admin route

  // Route: GET /projects
  if (pathname === '/projects' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return true;
    try {
      const pool = getPool();
      const result = await pool.query(
        `SELECT project_key AS "projectKey", display_name AS "displayName",
                target_repository AS "targetRepository", base_branch AS "baseBranch",
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM projects ORDER BY project_key`,
      );
      sendJson(res, 200, { projects: result.rows as unknown[] } as Record<string, unknown>);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[AdminApi] GET /projects failed:', msg);
      sendJson(res, 500, { error: 'Failed to retrieve projects' });
    }
    return true;
  }

  // Route: POST /projects
  if (pathname === '/projects' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return true;
    let body: { projectKey?: unknown; displayName?: unknown; targetRepository?: unknown; baseBranch?: unknown };
    try {
      body = JSON.parse(await readRequestBody(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const { projectKey, displayName, targetRepository, baseBranch } = body;
    if (!projectKey || !displayName || !targetRepository) {
      sendJson(res, 400, { error: 'Missing required fields: projectKey, displayName, targetRepository' });
      return true;
    }
    try {
      const pool = getPool();
      const existing = await pool.query(
        `SELECT project_key FROM projects WHERE project_key = $1`,
        [projectKey],
      );
      await pool.query(
        `INSERT INTO projects (project_key, display_name, target_repository, base_branch)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (project_key) DO UPDATE
           SET display_name      = EXCLUDED.display_name,
               target_repository = EXCLUDED.target_repository,
               base_branch       = EXCLUDED.base_branch,
               updated_at        = NOW()`,
        [projectKey, displayName, targetRepository, baseBranch ?? 'main'],
      );
      const statusCode = existing.rows.length === 0 ? 201 : 200;
      sendJson(res, statusCode, {
        projectKey,
        displayName,
        targetRepository,
        baseBranch: baseBranch ?? 'main',
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[AdminApi] POST /projects failed:', msg);
      sendJson(res, 500, { error: 'Failed to upsert project' });
    }
    return true;
  }

  // Route: GET /projects/:projectKey/artifacts
  const artifactsGetMatch = pathname.match(/^\/projects\/([^/]+)\/artifacts$/);
  if (artifactsGetMatch && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return true;
    const projectKey = decodeURIComponent(artifactsGetMatch[1]);
    try {
      const pool = getPool();
      const result = await pool.query(
        `SELECT id, artifact_type AS "artifactType", artifact_key AS "artifactKey",
                content, project_key AS "projectKey",
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM project_context
         WHERE project_key = $1
         ORDER BY artifact_type, artifact_key`,
        [projectKey],
      );
      sendJson(res, 200, { artifacts: result.rows as unknown[] } as Record<string, unknown>);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[AdminApi] GET /projects/${projectKey}/artifacts failed:`, msg);
      sendJson(res, 500, { error: 'Failed to retrieve artifacts' });
    }
    return true;
  }

  // Route: POST /projects/:projectKey/artifacts
  const artifactsPostMatch = pathname.match(/^\/projects\/([^/]+)\/artifacts$/);
  if (artifactsPostMatch && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return true;
    const projectKey = decodeURIComponent(artifactsPostMatch[1]);
    let body: { artifactType?: unknown; artifactKey?: unknown; content?: unknown };
    try {
      body = JSON.parse(await readRequestBody(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const { artifactType, artifactKey, content } = body;
    if (!artifactType || !artifactKey || content === undefined) {
      sendJson(res, 400, { error: 'Missing required fields: artifactType, artifactKey, content' });
      return true;
    }
    try {
      const pool = getPool();
      // artifact_key has UNIQUE constraint (migration 007) — ON CONFLICT is safe
      await pool.query(
        `INSERT INTO project_context (artifact_type, artifact_key, content, project_key)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (artifact_key) DO UPDATE
           SET artifact_type = EXCLUDED.artifact_type,
               content       = EXCLUDED.content,
               project_key   = EXCLUDED.project_key,
               updated_at    = NOW()`,
        [
          artifactType,
          artifactKey,
          typeof content === 'string' ? content : JSON.stringify(content),
          projectKey,
        ],
      );
      sendJson(res, 201, { artifactKey, artifactType, projectKey });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[AdminApi] POST /projects/${projectKey}/artifacts failed:`, msg);
      sendJson(res, 500, { error: 'Failed to upsert artifact' });
    }
    return true;
  }

  // Route: DELETE /projects/:projectKey/artifacts/:artifactKey
  const artifactDeleteMatch = pathname.match(/^\/projects\/([^/]+)\/artifacts\/([^/]+)$/);
  if (artifactDeleteMatch && req.method === 'DELETE') {
    if (!checkAdminAuth(req, res)) return true;
    const projectKey = decodeURIComponent(artifactDeleteMatch[1]);
    const artifactKey = decodeURIComponent(artifactDeleteMatch[2]);
    try {
      const pool = getPool();
      const result = await pool.query(
        `DELETE FROM project_context WHERE artifact_key = $1 AND project_key = $2`,
        [artifactKey, projectKey],
      );
      if ((result.rowCount ?? 0) === 0) {
        sendJson(res, 404, { error: `Artifact not found: ${artifactKey}` });
      } else {
        sendJson(res, 200, { deleted: true, artifactKey, projectKey });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[AdminApi] DELETE /projects/${projectKey}/artifacts/${artifactKey} failed:`, msg);
      sendJson(res, 500, { error: 'Failed to delete artifact' });
    }
    return true;
  }

  // No admin route matched
  return false;
}
