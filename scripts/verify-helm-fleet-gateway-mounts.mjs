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
}
