const branchManager = require('./branchManager');
const logger = require('../utils/logger');

/**
 * Executes a story workflow
 * @param {Object} story - The story object
 * @param {string} story.id - The story ID
 */
function executeStory(story) {
  try {
    logger.info(`Starting execution for story: ${story.id}`);
    
    // Create execution branch - halt on failure
    const branchRef = branchManager.createExecutionBranch(story.id);
    
    logger.info(`Execution branch established: ${branchRef}`);
    
    return {
      success: true,
      branchRef
    };
  } catch (error) {
    logger.error(`Execution halted: ${error.message}`);
    throw error;
  }
}

module.exports = {
  executeStory
};
