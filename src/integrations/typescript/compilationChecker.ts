import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileOperation } from '../../domain/instructionPacket';

const execAsync = promisify(exec);

const TSC_TIMEOUT_MS = 60_000;

export class CompilationChecker {
  private readonly appRoot: string;
  private readonly tscPath: string;

  constructor() {
    this.appRoot = process.cwd();
    this.tscPath = path.join(this.appRoot, 'node_modules', '.bin', 'tsc');
  }

  /**
   * Applies fileOperations to a temp copy of src/ and returns only the NEW
   * TypeScript errors introduced by those changes (baseline errors filtered out).
   * Returns [] if the environment is not suitable for compilation (non-fatal).
   */
  async check(fileOperations: FileOperation[]): Promise<string[]> {
    const tsFiles = fileOperations.filter(
      (op) => op.path.startsWith('src/') && op.path.endsWith('.ts'),
    );
    if (tsFiles.length === 0) return [];

    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'orky-tsc-'));
    try {
      await this.setupTempDir(tempDir);
      const baseline = await this.runTsc(tempDir);
      await this.applyFileOperations(tempDir, tsFiles);
      const withDip = await this.runTsc(tempDir);
      return this.delta(baseline, withDip);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[CompilationChecker] Infrastructure error (check skipped): ${msg}`);
      return [];
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async setupTempDir(tempDir: string): Promise<void> {
    const srcDir = path.join(this.appRoot, 'src');
    const tempSrcDir = path.join(tempDir, 'src');

    await this.copyDir(srcDir, tempSrcDir);

    await fs.promises.copyFile(
      path.join(this.appRoot, 'tsconfig.json'),
      path.join(tempDir, 'tsconfig.json'),
    );

    await fs.promises.symlink(
      path.join(this.appRoot, 'node_modules'),
      path.join(tempDir, 'node_modules'),
    );
  }

  private async copyDir(src: string, dest: string): Promise<void> {
    await fs.promises.mkdir(dest, { recursive: true });
    const entries = await fs.promises.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        await this.copyDir(srcPath, destPath);
      } else {
        await fs.promises.copyFile(srcPath, destPath);
      }
    }
  }

  private async applyFileOperations(tempDir: string, fileOperations: FileOperation[]): Promise<void> {
    for (const op of fileOperations) {
      const fullPath = path.join(tempDir, op.path);
      if (op.operation === 'delete') {
        await fs.promises.rm(fullPath, { force: true });
      } else if (op.content !== undefined) {
        await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.promises.writeFile(fullPath, op.content, 'utf-8');
      }
    }
  }

  private async runTsc(cwd: string): Promise<Set<string>> {
    try {
      const { stdout, stderr } = await execAsync(`"${this.tscPath}" --noEmit`, {
        cwd,
        timeout: TSC_TIMEOUT_MS,
      });
      return this.parseErrors(stdout + stderr, cwd);
    } catch (err: unknown) {
      // tsc exits non-zero when there are type errors — that's expected
      const execErr = err as { stdout?: string; stderr?: string; killed?: boolean };
      if (execErr.killed) throw new Error('tsc timed out');
      return this.parseErrors((execErr.stdout ?? '') + (execErr.stderr ?? ''), cwd);
    }
  }

  private parseErrors(output: string, tempDir: string): Set<string> {
    const errors = new Set<string>();
    const sep = path.sep === '\\' ? '\\\\' : '/';
    const escapedTempDir = tempDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tempDirRegex = new RegExp(escapedTempDir + sep + '?', 'g');

    for (const line of output.split('\n')) {
      if (!line.includes('error TS')) continue;
      const normalized = line.replace(tempDirRegex, '').trim();
      errors.add(normalized);
    }
    return errors;
  }

  private delta(baseline: Set<string>, withDip: Set<string>): string[] {
    const newErrors: string[] = [];
    for (const error of withDip) {
      if (!baseline.has(error)) {
        newErrors.push(error);
      }
    }
    return newErrors;
  }
}
