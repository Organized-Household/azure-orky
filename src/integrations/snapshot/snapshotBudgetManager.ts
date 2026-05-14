/**
 * SnapshotBudgetManager
 *
 * Smart budget allocation for codebase snapshot content:
 *   Phase 1 — extract interface/type declarations from every file (always valid TS)
 *   Phase 2 — upgrade as many files as possible to their full content using
 *              any remaining budget, prioritising earlier files in the list
 *
 * A file is NEVER partially included in a way that produces invalid TypeScript:
 *   - Either declarations-only (syntactically complete) is included, OR
 *   - The full file is included, OR
 *   - The file is skipped entirely.
 */

export interface BudgetedFile {
  path: string;
  content: string;
  truncated: boolean; // true → declarations-only; false → full content
}

export class SnapshotBudgetManager {
  /**
   * @param files   Ordered list of candidate files (earlier = higher priority)
   * @param budget  Maximum total character count across all included content
   */
  allocate(files: Array<{ path: string; content: string }>, budget: number): BudgetedFile[] {
    const result: BudgetedFile[] = [];
    let remaining = budget;

    // Phase 1: include declarations-only for every file that fits
    for (const file of files) {
      if (remaining <= 0) break;
      const decl = extractDeclarations(file.content);
      if (decl.length === 0) continue;

      if (decl.length <= remaining) {
        result.push({ path: file.path, content: decl, truncated: true });
        remaining -= decl.length;
      } else {
        console.warn(
          `[SnapshotBudgetManager] ${file.path}: declarations (${decl.length} chars) exceed remaining budget (${remaining}) — skipped`,
        );
      }
    }

    // Phase 2: upgrade to full content in insertion order
    for (const slot of result) {
      if (remaining <= 0) break;
      const original = files.find((f) => f.path === slot.path);
      if (!original) continue;

      const upgradeNeeded = original.content.length - slot.content.length;
      if (upgradeNeeded <= remaining) {
        slot.content = original.content;
        slot.truncated = false;
        remaining -= upgradeNeeded;
      }
    }

    return result;
  }
}

// ── Declaration extraction ────────────────────────────────────────────────────

/**
 * Returns a syntactically valid TypeScript subset of `source` containing only:
 *   - import statements
 *   - interface, type, and enum declarations
 *   - export { ... } re-exports
 *
 * Block boundaries are found by counting braces; single-line type aliases
 * (e.g. `type Foo = string;`) are terminated by their trailing semicolon.
 */
export function extractDeclarations(source: string): string {
  const lines = source.split('\n');
  const kept: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const trimmed = lines[i].trimStart();

    // ── import statements ─────────────────────────────────────────────────
    if (/^import\s/.test(trimmed)) {
      const block = collectUntilSemicolon(lines, i);
      kept.push(...block.lines);
      i += block.count;
      continue;
    }

    // ── interface / type / enum / abstract class declarations ─────────────
    if (/^(export\s+)?(interface|type|enum|abstract\s+class)\s/.test(trimmed)) {
      const block = collectBracedBlock(lines, i);
      kept.push(...block.lines);
      i += block.count;
      continue;
    }

    // ── export type { ... } re-exports ────────────────────────────────────
    if (/^export\s+type\s*\{/.test(trimmed)) {
      const block = collectBracedBlock(lines, i);
      kept.push(...block.lines);
      i += block.count;
      continue;
    }

    // ── export { ... } value re-exports ──────────────────────────────────
    if (/^export\s*\{/.test(trimmed)) {
      const block = collectBracedBlock(lines, i);
      kept.push(...block.lines);
      i += block.count;
      continue;
    }

    i++;
  }

  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Collects lines starting at `start` until a line whose trimmed end is `;`.
 * Handles both single-line imports and multi-line `import { ... } from '...'`.
 */
function collectUntilSemicolon(
  lines: string[],
  start: number,
): { lines: string[]; count: number } {
  let i = start;
  while (i < lines.length) {
    if (lines[i].trimEnd().endsWith(';')) {
      i++;
      break;
    }
    i++;
  }
  return { lines: lines.slice(start, i), count: i - start };
}

/**
 * Collects a complete brace-balanced block starting at `start`.
 * Also terminates on a trailing `;` before any brace is opened
 * (covers single-line type aliases: `type Foo = string;`).
 */
function collectBracedBlock(
  lines: string[],
  start: number,
): { lines: string[]; count: number } {
  let depth = 0;
  let foundBrace = false;
  let i = start;

  while (i < lines.length) {
    const line = lines[i];

    for (const ch of line) {
      if (ch === '{') {
        depth++;
        foundBrace = true;
      } else if (ch === '}') {
        depth--;
      }
    }

    i++;

    if (foundBrace && depth === 0) break;

    // Single-line declaration with no braces (e.g. `type Id = string;`)
    if (!foundBrace && line.trimEnd().endsWith(';')) break;
  }

  return { lines: lines.slice(start, i), count: i - start };
}
