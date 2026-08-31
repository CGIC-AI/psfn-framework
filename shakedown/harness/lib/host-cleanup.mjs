export async function runHostCleanupSteps(steps) {
  const cleanup = {};
  const cleanupErrors = [];
  for (const step of steps) {
    try {
      cleanup[step.name] = await step.run();
    } catch (error) {
      cleanupErrors.push(
        `${step.failureLabel}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { cleanup, cleanupErrors };
}
