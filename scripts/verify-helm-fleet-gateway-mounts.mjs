export function verifyFleetGatewayCompanionMountContract({
  deployment,
  companions,
  assertRenderFails,
  renderArgs,
}) {
  const gatewayContainer = deployment?.spec?.template?.spec?.containers
    ?.find(container => container.name === 'gateway');
  const gatewayVolumes = new Map(
    (deployment?.spec?.template?.spec?.volumes ?? [])
      .map(volume => [volume.name, volume]),
  );

  for (const [index, companion] of companions.entries()) {
    const volumeName = index === 0 ? 'companion-data' : `gateway-companion-data-${index}`;
    const volume = gatewayVolumes.get(volumeName);
    if (volume?.persistentVolumeClaim?.claimName !== companion.companionDataClaim) {
      throw new Error(
        `fleet gateway ${volumeName} must bind companion claim ${companion.companionDataClaim}`,
      );
    }
    const rootMountPath = `/runtime/companions/${companion.companionId}`;
    const rootMount = (gatewayContainer?.volumeMounts ?? [])
      .find(mount => mount.name === volumeName && mount.mountPath === rootMountPath);
    if (rootMount?.readOnly !== true) {
      throw new Error(
        `fleet gateway companion[${index}] owner root must mount read-only at ${rootMountPath}`,
      );
    }

    // The gateway executes workspace-scoped boundary tools for every
    // registered companion: each Personal Workspace claim must be bound
    // writable at its canonical <runtimeRoot>/workspaces/personal path.
    const workspaceVolumeName = index === 0 ? 'workspace' : `gateway-workspace-${index}`;
    const workspaceVolume = gatewayVolumes.get(workspaceVolumeName);
    if (workspaceVolume?.persistentVolumeClaim?.claimName !== companion.workspaceClaim) {
      throw new Error(
        `fleet gateway ${workspaceVolumeName} must bind workspace claim ${companion.workspaceClaim}`,
      );
    }
    const workspaceMountPath = `/runtime/workspaces/personal/${companion.companionId}`;
    const workspaceMount = (gatewayContainer?.volumeMounts ?? [])
      .find(mount => mount.name === workspaceVolumeName && mount.mountPath === workspaceMountPath);
    if (!workspaceMount || workspaceMount.readOnly === true) {
      throw new Error(
        `fleet gateway companion[${index}] Personal Workspace must mount writable at ${workspaceMountPath}`,
      );
    }
  }

  assertRenderFails(
    renderArgs([
      companions[0],
      {
        ...companions[1],
        companionDataClaim: '',
      },
    ]),
    'fleet.companions[1].companionDataClaim is required',
  );
  assertRenderFails(
    renderArgs([
      companions[0],
      {
        ...companions[1],
        companionDataClaim: companions[0].companionDataClaim,
      },
    ]),
    `fleet companionDataClaim is duplicated: ${companions[0].companionDataClaim}`,
  );
  assertRenderFails(
    renderArgs([
      companions[0],
      {
        ...companions[1],
        workspaceClaim: '',
      },
    ]),
    'fleet.companions[1].workspaceClaim is required',
  );
  assertRenderFails(
    renderArgs([
      companions[0],
      {
        ...companions[1],
        workspaceClaim: companions[0].workspaceClaim,
      },
    ]),
    `fleet workspaceClaim is duplicated: ${companions[0].workspaceClaim}`,
  );
}
