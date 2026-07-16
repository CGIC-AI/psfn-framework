export class FleetAuthBrokerError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message = code,
  ) {
    super(message);
    this.name = 'FleetAuthBrokerError';
  }
}
