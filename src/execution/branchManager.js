const { execSync } = require('child_process');
const logger = require('../utils/logger');

class BranchManager {
  /**
   * Creates a branch for story execution
   * @param {string} storyId - The story identifier
   * @returns {string} - The branch reference
   * @throws {Error} - If branch creation fails
   */
  createExecutionBranch(storyId) {
    const branchName = `story/${storyId.toLowerCase()}`;
    
    try {
      logger.info(`Creating execution branch: ${branchName}`);
      
      // Create the branch
      execSync(`git checkout -b ${branchName}`, { stdio: 'pipe' });
      
      // Get the branch reference
      const branchRef = execSync('git rev-parse --abbrev-ref HEAD', { 
        encoding: 'utf-8' 
      }).trim();
      
      logger.info(`Branch created successfully: ${branchRef}`);
      logger.info(`Branch reference: ${branchRef}`);
      
      return branchRef;
    } catch (error) {
      logger.error(`Branch creation failed for story ${storyId}: ${error.message}`);
      throw new Error(`Failed to create execution branch: ${error.message}`);
    }
  }

  /**
   * Verifies if a branch exists
   * @param {string} branchName - The branch name
   * @returns {boolean} - True if branch exists
   */
  branchExists(branchName) {
    try {
      execSync(`git rev-parse --verify ${branchName}`, { stdio: 'pipe' });
      return true;
    } catch (error) {
      return false;
    }
  }
}

module.exports = new BranchManager();
