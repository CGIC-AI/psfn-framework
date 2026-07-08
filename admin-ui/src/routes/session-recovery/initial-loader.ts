export interface SessionRecoveryRoutesResult<TRoute, TChannel> {
  routes: TRoute[];
  channels: TChannel[];
}

export interface SessionRecoveryCogSecResult<TEvent> {
  events: TEvent[];
}

export interface SessionRecoveryInitialLoaderDeps<
  TRoute extends { sourceChannelId: string },
  TChannel,
  TEvent,
> {
  fetchRoutes: () => Promise<SessionRecoveryRoutesResult<TRoute, TChannel>>;
  fetchCogSecEvents: () => Promise<SessionRecoveryCogSecResult<TEvent>>;
  getSelectedSourceChannelId: () => string;
  onStart: () => void;
  onRoutes: (data: SessionRecoveryRoutesResult<TRoute, TChannel>) => void;
  onCogSecEvents: (events: TEvent[]) => void;
  onSelectSourceChannelId: (sourceChannelId: string) => void;
  onError: (message: string) => void;
  onSettled: () => void;
}

export function createSessionRecoveryInitialLoader<
  TRoute extends { sourceChannelId: string },
  TChannel,
  TEvent,
>(
  deps: SessionRecoveryInitialLoaderDeps<TRoute, TChannel, TEvent>,
): () => Promise<void> {
  return async function loadSessionRecoveryInitialData(): Promise<void> {
    deps.onStart();
    try {
      const data = await deps.fetchRoutes();
      const cogSecData = await deps.fetchCogSecEvents();
      deps.onRoutes(data);
      deps.onCogSecEvents(cogSecData.events);
      if (!deps.getSelectedSourceChannelId() && data.routes[0]) {
        deps.onSelectSourceChannelId(data.routes[0].sourceChannelId);
      }
    } catch (e) {
      deps.onError(e instanceof Error ? e.message : 'Failed to load session routes');
    } finally {
      deps.onSettled();
    }
  };
}
