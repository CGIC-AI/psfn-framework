import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

function readSource(fileName: string): string {
  return readFileSync(join(SRC_DIR, fileName), 'utf-8');
}

describe('agent control plane', () => {
  it('agent-main delegates operator surfaces to the extracted helper', () => {
    const agentMainSource = readSource('main.ts');
    expect(agentMainSource).toContain('buildAgentControlPlane(');
    expect(agentMainSource).not.toContain('createSystemTool(');
    expect(agentMainSource).not.toContain('createNotifyTool(');
    expect(agentMainSource).not.toContain('createDiscordLifecycleNotifier(');
  });

  it('control-plane owns lifecycle notifier, tools, and shutdown sequencing', () => {
    const controlPlaneSource = readSource('control-plane.ts');
    expect(controlPlaneSource).toContain('createDiscordLifecycleNotifier');
    expect(controlPlaneSource).toContain('createSystemTool(');
    expect(controlPlaneSource).toContain('createNotifyDispatcher(');
    expect(controlPlaneSource).toContain('createNotifyTool(');
    expect(controlPlaneSource).toContain('createIcpAutonomyCandidateDispatcher({ agentLoop })');
    expect(controlPlaneSource).toContain('registerDeferredCompanionOutreachRuntime');
    expect(controlPlaneSource).toContain("capabilityRuntime.has('external.companion')");
    expect(controlPlaneSource).toContain("tool.name === 'notify'");
    expect(controlPlaneSource).toContain("getExtendedToolTurnClass('notify') === 'overlay'");
    expect(controlPlaneSource).toContain('resolveCompanionOutreachOriginActivationSource');
    expect(controlPlaneSource).toContain('isDeferredCompanionOutreachExecutionAuthorized');
    expect(controlPlaneSource).toContain('createGatewayDiscordNotifySender(');
    expect(controlPlaneSource).toContain('runShutdownSequence(');
    expect(controlPlaneSource).toContain('resolveRuntimeCommandInvocation');
    expect(controlPlaneSource).toContain('runRepoLifecycleBuildCommand');
    expect(controlPlaneSource).not.toContain("gateway.shellExec('npm', ['run', 'build']");
    expect(controlPlaneSource).toContain('unregister gateway disconnect hook');
    expect(controlPlaneSource).toContain('write graceful shutdown markers');
    expect(controlPlaneSource).toContain('close app cache');
    expect(readSource('main.ts')).toContain('shutdownTargets.appCache = appCache');
  });

  it('registers deferred handlers and the target command before starting restored actions', () => {
    const agentMainSource = readSource('main.ts');
    const controlPlaneIndex = agentMainSource.indexOf('buildAgentControlPlane({');
    const lateValidationIndex = agentMainSource.indexOf(
      "agentLoop.validateToolWiring('gateway'",
      controlPlaneIndex,
    );
    const commandIndex = agentMainSource.indexOf('registerIcpTargetChannelInitiationCommand(');
    const schedulerStartIndex = agentMainSource.indexOf('scheduler.start();');
    expect(controlPlaneIndex).toBeGreaterThan(-1);
    expect(lateValidationIndex).toBeGreaterThan(controlPlaneIndex);
    expect(commandIndex).toBeGreaterThan(controlPlaneIndex);
    expect(schedulerStartIndex).toBeGreaterThan(commandIndex);
    expect(schedulerStartIndex).toBeGreaterThan(lateValidationIndex);
    expect(readSource('scheduler-runtime.ts')).not.toContain('scheduler.start();');
  });

  it('registers the production candidate dispatcher only after the real notify tool', () => {
    const controlPlaneSource = readSource('control-plane.ts');
    const notifyRegistrationIndex = controlPlaneSource.indexOf(
      'agentLoop.registerTool(createNotifyTool(',
    );
    const candidateDispatcherIndex = controlPlaneSource.indexOf(
      'createIcpAutonomyCandidateDispatcher({ agentLoop })',
    );
    expect(notifyRegistrationIndex).toBeGreaterThan(-1);
    expect(candidateDispatcherIndex).toBeGreaterThan(notifyRegistrationIndex);
    expect(controlPlaneSource).toContain(
      'icpAutonomyCandidateDispatcher?: IcpAutonomyCandidateDispatcher',
    );
  });
});
