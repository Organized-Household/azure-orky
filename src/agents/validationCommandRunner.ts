import { execSync } from 'child_process';

export interface ValidationRunResult {
  success: boolean;
  output: string;
  failedCommand?: string;
}

export class ValidationCommandRunner {
  run(commands: string[], workspacePath: string): ValidationRunResult {
    const outputLines: string[] = [];

    for (const command of commands) {
      try {
        const result = execSync(command, {
          cwd: workspacePath,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 120_000,
        });
        outputLines.push(`[PASS] ${command}\n${result}`);
      } catch (error: unknown) {
        const stderr =
          error instanceof Error && 'stderr' in error
            ? String((error as NodeJS.ErrnoException & { stderr?: string }).stderr)
            : '';
        const stdout =
          error instanceof Error && 'stdout' in error
            ? String((error as NodeJS.ErrnoException & { stdout?: string }).stdout)
            : '';
        outputLines.push(`[FAIL] ${command}\nstdout: ${stdout}\nstderr: ${stderr}`);
        return {
          success: false,
          output: outputLines.join('\n'),
          failedCommand: command,
        };
      }
    }

    return {
      success: true,
      output: outputLines.join('\n'),
    };
  }
}
