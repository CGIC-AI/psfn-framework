export function verifyFleetGatewayCompanionMountContract({
  deployment,
  companions,
  assertRenderFails,
  renderArgs,
}) {
  const gatewayContainer = deployment?.spec?.template?.spec?.containers
    ?.find(container => container.name === 'gateway');
  if (!gatewayContainer) {
    throw new Error('fleet gateway Deployment must render a gateway container');
  }
  const gatewayVolumeMounts = gatewayContainer.volumeMounts ?? [];
  const duplicateMountPaths = gatewayVolumeMounts
    .map(mount => mount.mountPath)
    .filter((mountPath, index, mountPaths) => mountPaths.indexOf(mountPath) !== index);
  if (duplicateMountPaths.length > 0) {
    throw new Error(
      `fleet gateway volume mount paths must be unique: ${duplicateMountPaths.join(', ')}`,
    );
  }

  const gatewayVolumeList = deployment?.spec?.template?.spec?.volumes ?? [];
  const duplicateVolumeNames = gatewayVolumeList
    .map(volume => volume.name)
    .filter((volumeName, index, volumeNames) => volumeNames.indexOf(volumeName) !== index);
  if (duplicateVolumeNames.length > 0) {
    throw new Error(
      `fleet gateway volume names must be unique: ${duplicateVolumeNames.join(', ')}`,
    );
  }
  const gatewayVolumes = new Map(
    gatewayVolumeList.map(volume => [volume.name, volume]),
  );

  const companionRootPaths = companions.map(
    companion => `/runtime/companions/${companion.companionId}`,
  );
  for (const [index, rootPath] of companionRootPaths.entries()) {
    for (const [otherIndex, otherRootPath] of companionRootPaths.entries()) {
      if (index !== otherIndex
        && (rootPath === otherRootPath || rootPath.startsWith(`${otherRootPath}/`))) {
        throw new Error(
          `fleet gateway companion[${index}] root collides with companion[${otherIndex}]`,
        );
      }
    }
  }

  for (const [index, companion] of companions.entries()) {
    const volumeName = index === 0 ? 'companion-data' : `gateway-companion-data-${index}`;
    const volume = gatewayVolumes.get(volumeName);
    if (volume?.persistentVolumeClaim?.claimName !== companion.companionDataClaim) {
      throw new Error(
        `fleet gateway ${volumeName} must bind companion claim ${companion.companionDataClaim}`,
      );
    }
    const rootMountPath = companionRootPaths[index];
    const stateMountPath = `${rootMountPath}/state`;
    const companionMounts = gatewayVolumeMounts.filter(mount => mount.name === volumeName);
    if (companionMounts.length !== 2) {
      throw new Error(
        `fleet gateway companion[${index}] must render exactly one owner-root mount and one state subPath mount`,
      );
    }
    const rootMount = companionMounts.find(mount => mount.mountPath === rootMountPath);
    if (rootMount?.readOnly !== true || Object.hasOwn(rootMount ?? {}, 'subPath')) {
      throw new Error(
        `fleet gateway companion[${index}] owner root must mount read-only at ${rootMountPath}`,
      );
    }
    const stateMount = companionMounts.find(mount => mount.mountPath === stateMountPath);
    if (stateMount?.subPath !== 'state' || stateMount.readOnly !== false) {
      throw new Error(
        `fleet gateway companion[${index}] state must mount writable at ${stateMountPath} with subPath state`,
      );
    }
    if (gatewayVolumeMounts.indexOf(rootMount) >= gatewayVolumeMounts.indexOf(stateMount)) {
      throw new Error(
        `fleet gateway companion[${index}] owner-root mount must precede its state subPath mount`,
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
    const workspaceMount = gatewayVolumeMounts
      .find(mount => mount.name === workspaceVolumeName && mount.mountPath === workspaceMountPath);
    if (!workspaceMount || workspaceMount.readOnly === true) {
      throw new Error(
        `fleet gateway companion[${index}] Personal Workspace must mount writable at ${workspaceMountPath}`,
      );
    }
  }

  if (companions.length < 2) return;

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
