/**
 * Maps PDE epic IDs to arrays of repo-relative file paths.
 * These files are fetched from GitHub before every Forge invocation
 * for the corresponding epic and injected into the prompt as context.
 *
 * Keep this list focused — only files directly relevant to the epic's
 * implementation surface. Total injected content is capped at SNAPSHOT_CHAR_LIMIT chars.
 * ORDER MATTERS: files are fetched in order and skipped once the budget is exhausted.
 * Put the most critical signature files first.
 */
export const epicFileMap: Record<string, string[]> = {
  'EPIC-1': [
    'src/webhooks/jiraWebhookController.ts',
    'src/webhooks/jiraWebhookValidator.ts',
    'src/integrations/jira/storyRetrievalService.ts',
    'src/integrations/jira/jiraClient.ts',
  ],
  'EPIC-2': [
    'src/integrations/forge/forgeClient.ts',
    'src/integrations/forge/instructionValidator.ts',
    'src/orchestrator/forgeOrchestrator.ts',
    'src/domain/instructionPacket.ts',
  ],
  'EPIC-3': [
    'src/agents/repositoryMutationExecutor.ts',
    'src/agents/claudeMutationAgent.ts',
    'src/agents/workspaceManager.ts',
    'src/agents/mutationAgentAdapter.ts',
  ],
  'EPIC-4': [
    'src/integrations/github/repositoryManager.ts',
    'src/integrations/github/pullRequestManager.ts',
    'src/integrations/github/prOrchestrator.ts',
    'src/integrations/github/githubClient.ts',
  ],
  'EPIC-5': [
    'src/integrations/github/ciStatusMonitor.ts',
    'src/integrations/github/ciPoller.ts',
    'src/integrations/github/mergeController.ts',
    'src/integrations/github/prOrchestrator.ts',
  ],
  'EPIC-6': [
    'src/integrations/jira/jiraUpdater.ts',
    'src/integrations/jira/failureReporter.ts',
    'src/integrations/jira/jiraClient.ts',
  ],
  'EPIC-7': [
    'src/orchestrator/failureHandler.ts',
    'src/orchestrator/executionFactory.ts',
  ],
  'EPIC-9': [
    'src/integrations/forge/forgeClient.ts',
    'src/orchestrator/forgeOrchestrator.ts',
    'src/domain/instructionPacket.ts',
    'src/integrations/forge/instructionValidator.ts',
    'src/db/repositories/projectContextRepository.ts',
    'src/db/repositories/decisionLogRepository.ts',
  ],
  'EPIC-10': [
    'src/integrations/forge/forgeClient.ts',
    'src/orchestrator/forgeOrchestrator.ts',
    'src/orchestrator/packetNegotiationOrchestrator.ts',
    'src/integrations/review/packetReviewer.ts',
    'src/integrations/typescript/compilationChecker.ts',
    'src/db/repositories/packetNegotiationRepository.ts',
    'src/db/repositories/instructionPacketRepository.ts',
  ],
  'EPIC-11': [
    // Signature-critical files first — Forge must see these to generate correct types
    'src/db/repositories/batchExecutionRepository.ts',   // 2.6k
    'src/integrations/jira/storyRetrievalService.ts',    // 6k  — retrieveStory() signature
    'src/db/repositories/executionRepository.ts',         // 5.1k
    'src/integrations/forge/forgePlannerClient.ts',       // 5.7k
    'src/domain/storyPayload.ts',                         // 1.2k
    'src/audit/auditLogger.ts',                           // 1.4k
    // Orchestration layer — cumulative ~22k here, all fit under 40k budget
    'src/orchestrator/batchOrchestrator.ts',              // 4.4k
    'src/orchestrator/batchCollector.ts',                 // 5.1k
    // Large/secondary files — truncated or skipped if budget runs out
    'src/orchestrator/forgeOrchestrator.ts',
    'src/webhooks/jiraWebhookController.ts',
    'src/agents/repositoryMutationExecutor.ts',
    'src/integrations/github/prOrchestrator.ts',
    'src/orchestrator/executionFactory.ts',
    'src/integrations/forge/forgeClient.ts',
  ],
  'EPIC-13': [
    'src/integrations/forge/forgeConstraints.ts',
    'src/integrations/forge/forgeClient.ts',
  ],
};

/** Maximum total character budget for injected codebase snapshot */
export const SNAPSHOT_CHAR_LIMIT = 40_000;
