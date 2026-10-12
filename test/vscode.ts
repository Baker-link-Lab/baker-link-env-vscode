const disposable = {dispose() {}};
const event = () => disposable;

export class EventEmitter<T> {
    private listeners: Array<(value: T) => void> = [];
    event = (listener: (value: T) => void) => {
        this.listeners.push(listener);
        return {
            dispose: () => {
                this.listeners = this.listeners.filter((candidate) => candidate !== listener);
            },
        };
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
    documentText: new Map<string, string>(),
    getConfiguration: (_: string, uri: {fsPath: string}) => ({
        get: () => workspace.configurations.get(uri.fsPath),
    }),
    openTextDocument: async (uri: {fsPath: string}) => {
        documents.push(uri);
        const lines = (workspace.documentText.get(uri.fsPath) ?? '').split(/\r?\n/);
        return {
            ...uri,
            languageId: 'rust',
            lineCount: lines.length,
            lineAt: (line: number) => ({text: lines[line]}),
        };
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
export const registeredTools = new Map<
    string,
    {
        invoke: (options: unknown, token: unknown) => Promise<unknown>;
        prepareInvocation?: (options: unknown) => unknown;
    }
>();
export class LanguageModelTextPart {
    constructor(public value: string) {}
}
export class LanguageModelToolResult {
    constructor(public content: unknown[]) {}
}
export class MarkdownString {
    constructor(public value = '') {}
    appendText(value: string) {
        this.value += value;
        return this;
    }
    appendCodeblock(value: string) {
        this.value += `\n\`\`\`\n${value}\n\`\`\`\n`;
        return this;
    }
}
export const lm = {
    registerTool: (
        name: string,
        tool: {
            invoke: (options: unknown, token: unknown) => Promise<unknown>;
            prepareInvocation?: (options: unknown) => unknown;
        },
    ) => {
        registeredTools.set(name, tool);
        return disposable;
    },
};
export class Position {
    constructor(
        public line: number,
        public character: number,
    ) {}
}
export class Location {
    range: {start: Position};
    constructor(
        public uri: {fsPath: string},
        position: Position,
    ) {
        this.range = {start: position};
    }
}
export class SourceBreakpoint {
    enabled: boolean;
    condition: string | undefined;
    hitCondition: string | undefined;
    constructor(
        public location: Location,
        enabled = true,
        condition?: string,
        hitCondition?: string,
    ) {
        this.enabled = enabled;
        this.condition = condition;
        this.hitCondition = hitCondition;
    }
}
export const debug = {
    activeDebugSession: undefined as vscode.DebugSession | undefined,
    breakpoints: [] as SourceBreakpoint[],
    onDidStartDebugSession: new EventEmitter<vscode.DebugSession>().event,
    onDidTerminateDebugSession: new EventEmitter<vscode.DebugSession>().event,
    addBreakpoints: (breakpoints: SourceBreakpoint[]) => debug.breakpoints.push(...breakpoints),
    removeBreakpoints: (breakpoints: SourceBreakpoint[]) => {
        debug.breakpoints = debug.breakpoints.filter(
            (breakpoint) => !breakpoints.includes(breakpoint),
        );
    },
    startDebugging: async (
        _folder: vscode.WorkspaceFolder,
        _name: string | vscode.DebugConfiguration,
    ) => true,
    stopDebugging: async (_session: vscode.DebugSession) => {},
};
export const TaskScope = {Workspace: 1, Global: 2};
export class Task {
    isBackground = false;
    constructor(
        public definition: vscode.TaskDefinition,
        public scope: vscode.WorkspaceFolder,
        public name: string,
        public source: string,
    ) {}
}
export const taskProcessEnd = new EventEmitter<vscode.TaskProcessEndEvent>();
export const taskEnd = new EventEmitter<vscode.TaskEndEvent>();
export const tasks = {
    fetchTasks: async (): Promise<vscode.Task[]> => [],
    taskExecutions: [] as vscode.TaskExecution[],
    onDidEndTaskProcess: taskProcessEnd.event,
    onDidEndTask: taskEnd.event,
    executeTask: async (_: vscode.Task): Promise<vscode.TaskExecution> => {
        throw new Error('Configure the task execution mock for this test.');
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
        fsPath: path.join(uri.fsPath, relative),
    }),
    file: (fsPath: string) => ({fsPath}),
};
import type * as vscode from 'vscode';
import * as path from 'node:path';
