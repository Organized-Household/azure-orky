import * as fs from 'fs';
import * as path from 'path';

/** Matches: import ... from './foo'  |  export * from '../bar' */
const LOCAL_IMPORT_RE = /\bfrom\s+['"](\.[^'"]+)['"]/g;

const MAX_DEPTH = 2;

export interface DependencyResolverResult {
  filePaths: string[];   // project-relative, forward-slash, deduplicated
  warnings: string[];
}

/**
 * Pure filesystem utility.
 * Given a set of seed file paths (from a DIP's fileOperations), reads their
 * import statements and returns a deduplicated, flattened list of all
 * reachable local source-file dependencies up to MAX_DEPTH levels deep.
 *
 * Seed files themselves are included in the result.
 * Non-existent files are skipped with a console.warn + warning entry.
 * No database calls, no network calls.
 */
export class DipDependencyResolver {
  private readonly projectRoot: string;

  constructor() {
    this.projectRoot = process.cwd();
  }

  async resolve(seedPaths: string[]): Promise<DependencyResolverResult> {
    const visited = new Set<string>();
    const warnings: string[] = [];

    for (const seedPath of seedPaths) {
      await this.resolveOne(
        this.normalize(seedPath),
        0,
        visited,
        warnings,
      );
    }

    return { filePaths: Array.from(visited), warnings };
  }

  // ── private ──────────────────────────────────────────────────────────────

  private async resolveOne(
    filePath: string,
    depth: number,
    visited: Set<string>,
    warnings: string[],
  ): Promise<void> {
    if (visited.has(filePath)) return;

    const absolutePath = path.join(this.projectRoot, filePath);
    let content: string;

    try {
      content = await fs.promises.readFile(absolutePath, 'utf-8');
    } catch {
      const msg = `[DipDependencyResolver] File not found, skipping: ${filePath}`;
      console.warn(msg);
      warnings.push(msg);
      return;
    }

    visited.add(filePath);

    // Stop recursing at max depth, but still record this file
    if (depth >= MAX_DEPTH) return;

    const fromDir = path.dirname(filePath).replace(/\\/g, '/');
    const localImports = this.extractLocalImports(content, fromDir);

    for (const imp of localImports) {
      await this.resolveOne(imp, depth + 1, visited, warnings);
    }
  }

  private extractLocalImports(source: string, fromDir: string): string[] {
    const results: string[] = [];
    LOCAL_IMPORT_RE.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = LOCAL_IMPORT_RE.exec(source)) !== null) {
      const specifier = match[1];
      const resolved = this.resolveSpecifier(fromDir, specifier);
      if (resolved !== null) results.push(resolved);
    }

    return results;
  }

  /**
   * Resolves a relative import specifier (e.g. '../db/client') from a given
   * source directory to a project-relative path (e.g. 'src/db/client.ts').
   *
   * Returns null for:
   * - Paths that escape outside src/ (unlikely but guarded)
   * - Non-TS files (e.g. JSON imports)
   */
  private resolveSpecifier(fromDir: string, specifier: string): string | null {
    const joined = path.join(fromDir, specifier).replace(/\\/g, '/');

    // Only follow paths within src/
    if (!joined.startsWith('src/')) return null;

    // Candidate list: explicit .ts, then add .ts, then /index.ts
    const candidates = joined.endsWith('.ts')
      ? [joined]
      : [`${joined}.ts`, `${joined}/index.ts`];

    for (const candidate of candidates) {
      if (fs.existsSync(path.join(this.projectRoot, candidate))) {
        return candidate;
      }
    }

    // File not on disk yet — return .ts candidate; resolveOne will warn on miss
    return joined.endsWith('.ts') ? joined : `${joined}.ts`;
  }

  private normalize(p: string): string {
    return p.replace(/\\/g, '/');
  }
}
