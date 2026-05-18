import { getPool } from '../../db/dbClient';
import { AuditLogger } from '../../audit/auditLogger';

interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  head_sha: string;
}

interface CIStatusResult {
  allPassed: boolean;
  requiredChecksPassed: boolean;
  failedChecks: string[];
  pendingChecks: string[];
}

export class CIStatusMonitor {
  private auditLogger: AuditLogger;

  constructor(auditLogger: AuditLogger) {
    this.auditLogger = auditLogger;
  }

  async evaluateChecks(
    executionId: string,
    storyId: string,
    checks: CheckRun[],
    requiredChecks: string[]
  ): Promise<CIStatusResult> {
    console.log(
      `[CIStatusMonitor] Evaluating ${checks.length} checks for execution ${executionId}`
    );

    const checkMap = new Map<string, CheckRun>();
    checks.forEach((r: CheckRun) => checkMap.set(r.name, r));

    const missingChecks = requiredChecks.filter((name: string) => !checkMap.has(name));
    const presentChecks = requiredChecks.filter((name: string) => checkMap.has(name));

    const failedChecks = presentChecks.filter((name: string) => {
      const run = checkMap.get(name);
      return run && run.status === 'completed' && run.conclusion !== 'success';
    });

    const pendingChecks = presentChecks.filter((name: string) => {
      const run = checkMap.get(name);
      return run && run.status !== 'completed';
    });

    const passedChecks = presentChecks.filter((name: string) => {
      const run = checkMap.get(name);
      return run && run.status === 'completed' && run.conclusion === 'success';
    });

    const requiredChecksPassed = missingChecks.length === 0 && failedChecks.length === 0 && pendingChecks.length === 0;
    const allPassed = requiredChecksPassed && passedChecks.length === requiredChecks.length;

    if (missingChecks.length > 0) {
      console.error(
        `[CIStatusMonitor] Execution ${executionId}: Missing required checks:`,
        missingChecks
      );
      await this.auditLogger.log({
        executionId,
        storyId,
        step: 'CI_STATUS_EVALUATION',
        state: 'CI_PENDING',
        status: 'WARNING',
        message: `Missing required checks: ${missingChecks.join(', ')}`,
        metadata: { missingChecks }
      });
    }

    if (failedChecks.length > 0) {
      console.error(
        `[CIStatusMonitor] Execution ${executionId}: Failed checks:`,
        failedChecks
      );
      await this.auditLogger.log({
        executionId,
        storyId,
        step: 'CI_STATUS_EVALUATION',
        state: 'CI_PENDING',
        status: 'FAILED',
        message: `Failed checks: ${failedChecks.join(', ')}`,
        metadata: { failedChecks }
      });
    }

    if (pendingChecks.length > 0) {
      console.log(
        `[CIStatusMonitor] Execution ${executionId}: Pending checks:`,
        pendingChecks
      );
    }

    if (allPassed) {
      console.log(
        `[CIStatusMonitor] Execution ${executionId}: All required checks passed`
      );
      await this.auditLogger.log({
        executionId,
        storyId,
        step: 'CI_STATUS_EVALUATION',
        state: 'CI_PASSED',
        status: 'SUCCESS',
        message: 'All required checks passed',
        metadata: { passedChecks }
      });
    }

    return {
      allPassed,
      requiredChecksPassed,
      failedChecks,
      pendingChecks
    };
  }
}
