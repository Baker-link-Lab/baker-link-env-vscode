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
    workspaceFolders: [] as vscode.WorkspaceFolder[],
    configurations: new Map<string, unknown[]>(),
    getConfiguration: (_: string, uri: {fsPath: string}) => ({
        get: () => workspace.configurations.get(uri.fsPath),
    }),
    openTextDocument: async (uri: {fsPath: string}) => {
        documents.push(uri);
        return uri;
    },
    onDidChangeWorkspaceFolders: event,
    onDidChangeConfiguration: event,
    createFileSystemWatcher: () => ({
        dispose() {},
        onDidChange: event,
        onDidCreate: event,
        onDidDelete: event,
    }),
};
export const commandHandlers = new Map<string, () => Promise<void>>();
export const commands = {
    registerCommand: (name: string, handler: () => Promise<void>) => {
        commandHandlers.set(name, handler);
        return disposable;
    },
};
export const messages: string[] = [];
export const documents: Array<{fsPath: string}> = [];
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
    showErrorMessage: async (message: string) => messages.push(message),
    showInformationMessage: async (message: string) => messages.push(message),
    selectedIndex: 0,
    showQuickPick: async <T>(items: T[]) => items[window.selectedIndex],
    showWorkspaceFolderPick: async () => undefined,
    openTextDocument: async () => undefined,
    showTextDocument: async () => undefined,
};
export const Uri = {
    joinPath: (uri: {fsPath: string}, relative: string) => ({
        fsPath: `${uri.fsPath}/${relative}`,
    }),
    file: (fsPath: string) => ({fsPath}),
};
import type * as vscode from 'vscode';
