import { FileOperation } from '../../domain/instructionPacket';
import { DipDependencyResolver } from './dipDependencyResolver';

export interface RuntimeSnapshotList {
  filePaths: string[];
  warnings: string[];
}

/**
 * Builds a file list for the codebase snapshot dynamically at runtime by
 * resolving the import graph of the DIP's target files.
 *
 * Only non-delete TypeScript operations are used as seed paths.
 * Returns an empty list (with no error) when there are no eligible seeds.
 */
export class RuntimeSnapshotBuilder {
  private readonly resolver = new DipDependencyResolver();

  async buildFileList(fileOperations: FileOperation[]): Promise<RuntimeSnapshotList> {
    const seedPaths = fileOperations
      .filter((op) => op.operation !== 'delete' && op.path.endsWith('.ts'))
      .map((op) => op.path);

    if (seedPaths.length === 0) {
      return { filePaths: [], warnings: [] };
    }

    const result = await this.resolver.resolve(seedPaths);

    console.log(
      `[RuntimeSnapshotBuilder] resolved ${result.filePaths.length} file(s) from ${seedPaths.length} seed(s)`,
    );
    if (result.warnings.length > 0) {
      console.warn(
        `[RuntimeSnapshotBuilder] ${result.warnings.length} warning(s):`,
        result.warnings,
      );
    }

    return result;
  }
}
