/** WebSocket RPC method names - mirrors @t3tools/contracts WS_METHODS */
export const WS_METHODS = {
  serverGetConfig: "server.getConfig",
  serverRefreshProviders: "server.refreshProviders",
} as const;

/** Orchestration RPC methods */
export const ORCHESTRATION_WS_METHODS = {
  getSnapshot: "orchestration.getSnapshot",
  dispatchCommand: "orchestration.dispatchCommand",
  replayEvents: "orchestration.replayEvents",
} as const;

/** Push event channels */
export const WS_CHANNELS = {
  serverWelcome: "server.welcome",
  serverConfigUpdated: "server.configUpdated",
  serverProvidersUpdated: "server.providersUpdated",
  gitActionProgress: "git.actionProgress",
  terminalEvent: "terminal.event",
} as const;

export const ORCHESTRATION_WS_CHANNELS = {
  domainEvent: "orchestration.domainEvent",
} as const;
