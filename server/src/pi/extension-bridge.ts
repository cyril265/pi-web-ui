type RegisteredExtensionCommand = {
  command: {
    name: string;
    description?: string;
  };
  extensionPath?: string;
};

type ExtensionCommandContextActions = {
  waitForIdle: () => Promise<void>;
  newSession: (options: any) => Promise<{ cancelled: boolean }>;
  fork: (entryId: string) => Promise<{ cancelled: boolean }>;
  navigateTree: (targetId: string, options: any) => Promise<{ cancelled: boolean }>;
  switchSession: (sessionPath: string) => Promise<{ cancelled: boolean }>;
  reload: () => Promise<void>;
};

type BridgeableSession = {
  extensionRunner?: {
    getRegisteredCommandsWithPaths?: () => RegisteredExtensionCommand[];
  };
  bindExtensions: (options: {
    uiContext: any;
    commandContextActions: ExtensionCommandContextActions;
    shutdownHandler: () => void;
    onError: (error: { error: string }) => void;
  }) => Promise<void>;
};

const asBridgeableSession = (session: unknown) => session as BridgeableSession;

export function getRegisteredExtensionCommands(session: unknown): RegisteredExtensionCommand[] {
  return asBridgeableSession(session).extensionRunner?.getRegisteredCommandsWithPaths?.() ?? [];
}

export async function bindSessionExtensions(options: {
  session: unknown;
  uiContext: unknown;
  commandContextActions: ExtensionCommandContextActions;
  onError: (error: { error: string }) => void;
}) {
  await asBridgeableSession(options.session).bindExtensions({
    uiContext: options.uiContext,
    commandContextActions: options.commandContextActions,
    shutdownHandler: () => {},
    onError: options.onError,
  });
}
