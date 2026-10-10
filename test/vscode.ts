const disposable = {dispose() {}};
const event = () => disposable;

export class EventEmitter<T> {
    private listeners: Array<(value: T) => void> = [];
    event = (listener: (value: T) => void) => {
        this.listeners.push(listener);
        return disposable;
    };
    fire(value: T) {
        this.listeners.forEach((listener) => listener(value));
    }
    dispose() {
        this.listeners = [];
    }
}

export const StatusBarAlignment = {Left: 1};
export const ProgressLocation = {Notification: 15};
export const workspace = {
    isTrusted: true,
    workspaceFolders: [],
    onDidChangeWorkspaceFolders: event,
    createFileSystemWatcher: () => ({
        dispose() {},
        onDidChange: event,
        onDidCreate: event,
        onDidDelete: event,
    }),
};
export const commands = {registerCommand: () => disposable};
export const window = {
    createOutputChannel: () => ({appendLine() {}, dispose() {}}),
    createStatusBarItem: () => ({show() {}, hide() {}, dispose() {}}),
    withProgress: async (
        _: unknown,
        action: (
            progress: unknown,
            token: {isCancellationRequested: boolean; onCancellationRequested: typeof event},
        ) => Promise<void>,
    ) => action({}, {isCancellationRequested: false, onCancellationRequested: event}),
    showErrorMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    showWorkspaceFolderPick: async () => undefined,
    openTextDocument: async () => undefined,
    showTextDocument: async () => undefined,
};
export const Uri = {
    joinPath: () => undefined,
    file: (fsPath: string) => ({fsPath}),
};
