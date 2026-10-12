import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {parse, type ParseError} from 'jsonc-parser/lib/esm/main.js';
import {DEBUG_TYPE} from './bakerLinkIntegration';
import {isRecord} from './bakerLink';
import {CargoArtifacts, type CargoInput} from './cargoArtifacts';
import {artifactDebugConfiguration, type DebugInput} from './artifactDebug';

const TOOL_PREFIX = 'baker-link-env_';

const BUILD_TASKS = {
    debug: 'cargo: build',
    release: 'cargo: build (release)',
    check: 'cargo: check',
} as const;

type BuildMode = keyof typeof BUILD_TASKS;

interface WorkspaceInput {
    workspaceFolder?: string;
}

interface BuildInput extends WorkspaceInput {
    mode: BuildMode;
}

interface CargoToolInput extends CargoInput, WorkspaceInput {}

interface TestInput extends CargoToolInput {
    mode: 'host' | 'embedded-build';
}

interface BreakpointInput extends WorkspaceInput {
    path: string;
    line: number;
}

interface ToolDefinition {
    name: string;
    register(id: string): vscode.Disposable;
}

type ToolHandler<T> = (input: T, token: vscode.CancellationToken) => Promise<unknown>;

class AgentTool<T> implements vscode.LanguageModelTool<T> {
    constructor(
        private readonly handler: ToolHandler<T>,
        private readonly prepare?: (
            input: T,
        ) => vscode.PreparedToolInvocation | Promise<vscode.PreparedToolInvocation>,
    ) {}

    prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<T>) {
        return this.prepare?.(options.input);
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<T>,
        token: vscode.CancellationToken,
    ) {
        if (token.isCancellationRequested) {
            throw new Error('The operation was cancelled before it started.');
        }
        const result = await this.handler(options.input, token);
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(result)),
        ]);
    }
}

function confirmation(
    title: string,
    message: string,
    invocationMessage: string,
): vscode.PreparedToolInvocation {
    return {
        invocationMessage,
        confirmationMessages: {title, message: new vscode.MarkdownString(message)},
    };
}

function requireTrustedWorkspace() {
    if (!vscode.workspace.isTrusted) {
        throw new Error('Trust this workspace before using Baker Link Agent tools.');
    }
}

function resolveWorkspaceFolder(input: WorkspaceInput): vscode.WorkspaceFolder {
    requireTrustedWorkspace();
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
        throw new Error('Open a Baker Link project folder first.');
    }
    if (input.workspaceFolder) {
        const identifier = input.workspaceFolder;
        const matching = folders.filter(
            (folder) =>
                folder.name === identifier ||
                path.resolve(folder.uri.fsPath) === path.resolve(identifier),
        );
        if (matching.length !== 1) {
            throw new Error(
                `Workspace folder not found or ambiguous: ${identifier}. Use a unique open workspace folder name or absolute path.`,
            );
        }
        return matching[0];
    }
    if (folders.length !== 1) {
        throw new Error(
            'Specify workspaceFolder by its open workspace folder name or absolute path.',
        );
    }
    return folders[0];
}

function relativePath(root: string, target: string): string | undefined {
    const relative = path.relative(root, target);
    if (
        !relative ||
        relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
    ) {
        return undefined;
    }
    return relative;
}

function isWorkspaceTask(task: vscode.Task, folder: vscode.WorkspaceFolder): boolean {
    if (task.scope === vscode.TaskScope.Workspace) {
        return true;
    }
    if (typeof task.scope === 'object') {
        return path.resolve(task.scope.uri.fsPath) === path.resolve(folder.uri.fsPath);
    }
    return false;
}

async function executeBuildTask(
    folder: vscode.WorkspaceFolder,
    mode: BuildMode,
    token: vscode.CancellationToken,
) {
    const label = BUILD_TASKS[mode];
    if (!label) {
        throw new Error(`Unsupported build mode: ${String(mode)}.`);
    }
    const tasks = await vscode.tasks.fetchTasks();
    const matching = tasks.filter((task) => task.name === label && isWorkspaceTask(task, folder));
    if (matching.length === 0) {
        throw new Error(
            `The "${label}" task is not configured for workspace "${folder.name}". Add it to .vscode/tasks.json.`,
        );
    }
    if (matching.length > 1) {
        throw new Error(`More than one "${label}" task is configured for this workspace.`);
    }
    const task = matching[0];
    if (task.isBackground) {
        throw new Error(`The "${label}" task must be a finite, non-background build task.`);
    }
    if (
        vscode.tasks.taskExecutions.some(
            (execution) =>
                execution.task.name === task.name && isWorkspaceTask(execution.task, folder),
        )
    ) {
        throw new Error(`The "${label}" task is already running.`);
    }
    if (token.isCancellationRequested) {
        throw new Error('The build task was cancelled.');
    }

    let execution: vscode.TaskExecution | undefined;
    type TaskOutcome =
        | {execution: vscode.TaskExecution; exitCode: number | undefined}
        | {execution: vscode.TaskExecution; error: Error};
    const earlyEvents: TaskOutcome[] = [];
    let resolveProcess!: (outcome: TaskOutcome) => void;
    const processResult = new Promise<TaskOutcome>((resolve) => {
        resolveProcess = resolve;
    });
    const receiveOutcome = (outcome: TaskOutcome) => {
        if (!execution) {
            earlyEvents.push(outcome);
        } else if (outcome.execution === execution) {
            resolveProcess(outcome);
        }
    };
    // VS Code may reconstruct Task objects and deliver events before executeTask resolves.
    const endProcessListener = vscode.tasks.onDidEndTaskProcess(receiveOutcome);
    const endTaskListener = vscode.tasks.onDidEndTask((event) =>
        receiveOutcome({
            execution: event.execution,
            error: new Error(`The "${label}" task ended without reporting a process exit code.`),
        }),
    );
    const cancellationListener = token.onCancellationRequested(() => execution?.terminate());
    try {
        execution = await vscode.tasks.executeTask(task);
        for (const outcome of earlyEvents) {
            receiveOutcome(outcome);
        }
        if (token.isCancellationRequested) {
            execution.terminate();
        }
        const outcome = await processResult;
        if ('error' in outcome) {
            throw outcome.error;
        }
        if (token.isCancellationRequested) {
            throw new Error(`The "${label}" task was cancelled.`);
        }
        const {exitCode} = outcome;
        if (exitCode !== 0) {
            throw new Error(
                exitCode === undefined
                    ? `The "${label}" task was terminated.`
                    : `The "${label}" task failed with exit code ${exitCode}.`,
            );
        }
        return {success: true, task: label, exitCode};
    } finally {
        endProcessListener.dispose();
        endTaskListener.dispose();
        cancellationListener.dispose();
    }
}

function bakerLinkSessions(folder: vscode.WorkspaceFolder): vscode.DebugSession[] {
    const sessions = new Set(knownDebugSessions);
    const active = vscode.debug.activeDebugSession;
    if (active) {
        sessions.add(active);
    }
    return [...sessions].filter(
        (session) =>
            session.type === DEBUG_TYPE &&
            session.workspaceFolder?.uri.fsPath === folder.uri.fsPath,
    );
}

const knownDebugSessions = new Set<vscode.DebugSession>();

function isBakerLinkConfiguration(config: unknown): config is vscode.DebugConfiguration {
    if (typeof config !== 'object' || config === null) {
        return false;
    }
    const candidate = config as Record<string, unknown>;
    return (
        candidate.type === DEBUG_TYPE &&
        candidate.request === 'launch' &&
        typeof candidate.name === 'string'
    );
}

async function configurations(
    folder: vscode.WorkspaceFolder,
): Promise<vscode.DebugConfiguration[]> {
    const file = path.join(folder.uri.fsPath, '.vscode', 'launch.json');
    let text: string;
    try {
        text = await fs.readFile(file, 'utf8');
    } catch (error) {
        if (!isRecord(error) || error.code !== 'ENOENT') {
            throw error;
        }
        return configuredLaunches(folder);
    }
    const errors: ParseError[] = [];
    const launch: unknown = parse(text, errors, {allowTrailingComma: true});
    if (errors.length || !isRecord(launch) || !Array.isArray(launch.configurations)) {
        throw new Error('Invalid .vscode/launch.json. Save a valid JSONC launch configuration.');
    }
    return launch.configurations.filter(isBakerLinkConfiguration);
}

function configuredLaunches(folder: vscode.WorkspaceFolder): vscode.DebugConfiguration[] {
    const value: unknown = vscode.workspace
        .getConfiguration('launch', folder.uri)
        .get('configurations');
    return Array.isArray(value) ? value.filter(isBakerLinkConfiguration) : [];
}

function selectConfiguration(available: vscode.DebugConfiguration[], name?: string) {
    const matches = name ? available.filter((config) => config.name === name) : available;
    if (matches.length !== 1) {
        throw new Error(
            available.length === 0
                ? 'No Baker Link launch configuration was found in .vscode/launch.json.'
                : `Specify configuration. Available configurations: ${available.map((config) => config.name).join(', ')}`,
        );
    }
    return matches[0];
}

async function withCargoCancellation<T>(
    token: vscode.CancellationToken,
    action: (signal: AbortSignal) => Promise<T>,
) {
    const controller = new AbortController();
    const listener = token.onCancellationRequested(() => controller.abort());
    if (token.isCancellationRequested) {
        controller.abort();
    }
    try {
        return await action(controller.signal);
    } finally {
        listener.dispose();
    }
}

async function resolveBreakpointTarget(folder: vscode.WorkspaceFolder, input: BreakpointInput) {
    if (!input.path || typeof input.path !== 'string') {
        throw new Error('path must identify a source file inside the workspace.');
    }
    if (!Number.isInteger(input.line) || input.line < 1) {
        throw new Error('line must be a positive, one-based line number.');
    }
    const workspaceRoot = await fs.realpath(folder.uri.fsPath);
    const candidatePath = path.resolve(folder.uri.fsPath, input.path);
    const sourcePath = await fs.realpath(candidatePath);
    if (!(await fs.stat(sourcePath)).isFile()) {
        throw new Error(`Breakpoint target is not a file: ${input.path}`);
    }
    const relative = relativePath(workspaceRoot, sourcePath);
    if (!relative) {
        throw new Error('Breakpoints can only be set on files inside the selected workspace.');
    }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
    if (!['rust', 'c', 'cpp', 'asm'].includes(document.languageId)) {
        throw new Error(
            `Source breakpoints are supported for Rust, C, C++, and Assembly files; ${relative} is identified as ${document.languageId}.`,
        );
    }
    if (input.line > document.lineCount) {
        throw new Error(
            `Line ${input.line} is outside ${relative}, which has ${document.lineCount} lines.`,
        );
    }
    return {
        path: sourcePath,
        relativePath: relative,
        line: input.line,
        sourceLine: document.lineAt(input.line - 1).text,
    };
}

function breakpointInWorkspace(
    breakpoint: vscode.Breakpoint,
    root: string,
): breakpoint is vscode.SourceBreakpoint {
    return (
        breakpoint instanceof vscode.SourceBreakpoint &&
        relativePath(root, breakpoint.location.uri.fsPath) !== undefined
    );
}

function getTools(cargo: CargoArtifacts): ToolDefinition[] {
    const pendingLaunches = new Set<string>();
    const inspectProject = new AgentTool<WorkspaceInput>(async (input, token) => {
        const folder = resolveWorkspaceFolder(input);
        const metadata = await withCargoCancellation(token, (signal) =>
            cargo.inspect(folder.uri.fsPath, signal),
        );
        return {
            ...metadata,
            configurations: (await configurations(folder)).map((config) => ({
                name: config.name,
                chip: config.chip,
                preLaunchTask: config.preLaunchTask,
            })),
        };
    });
    const buildArtifact = new AgentTool<CargoToolInput>(
        async (input, token) => {
            const folder = resolveWorkspaceFolder(input);
            return withCargoCancellation(token, (signal) =>
                cargo.build(folder.uri.fsPath, input, signal),
            );
        },
        (input) =>
            confirmation(
                'Build Cargo artifact?',
                `Build ${input.package ?? 'the selected package'} ${input.kind} ${input.name ?? ''} (${input.profile ?? 'debug'}), features: ${(input.features ?? []).join(', ') || 'defaults'}, noDefaultFeatures: ${input.noDefaultFeatures ?? false}, target: ${input.targetTriple ?? 'Cargo configured default'}. Cargo can execute project build scripts.`,
                'Building Cargo artifact',
            ),
    );
    const runTests = new AgentTool<TestInput>(
        async (input, token) => {
            const folder = resolveWorkspaceFolder(input);
            if (input.mode !== 'host' && input.mode !== 'embedded-build') {
                throw new Error('Test mode must be host or embedded-build.');
            }
            if (input.mode === 'embedded-build' && (input.kind === 'bin' || input.testFilter)) {
                throw new Error('embedded-build supports test/lib harnesses without testFilter.');
            }
            return withCargoCancellation<unknown>(token, (signal) =>
                input.mode === 'host'
                    ? cargo.test(folder.uri.fsPath, input, signal)
                    : cargo.build(folder.uri.fsPath, input, signal),
            );
        },
        (input) =>
            confirmation(
                'Run or build Cargo tests?',
                `${input.mode === 'host' ? 'Execute host tests' : 'Build tests without executing on hardware'} for ${input.package ?? 'the selected package'} ${input.kind} ${input.name ?? ''}. Target: ${input.targetTriple ?? 'Cargo configured default'}, features: ${(input.features ?? []).join(', ') || 'defaults'}, profile: ${input.profile ?? 'debug'}. Test filter: ${input.testFilter ?? '(all)'}. Cargo may execute project build scripts.`,
                'Processing Cargo tests',
            ),
    );
    const build = new AgentTool<BuildInput>(
        async (input, token) => {
            const folder = resolveWorkspaceFolder(input);
            return executeBuildTask(folder, input.mode, token);
        },
        (input) =>
            confirmation(
                'Run Baker Link build task?',
                `Run the configured **${BUILD_TASKS[input.mode] ?? input.mode}** task in the selected workspace. The task may execute project-defined build scripts.`,
                `Building (${input.mode})`,
            ),
    );

    const startDebugging = new AgentTool<DebugInput>(
        async (input, token) => {
            const folder = resolveWorkspaceFolder(input);
            const current = bakerLinkSessions(folder);
            if (current.length > 0) {
                return {
                    success: true,
                    alreadyRunning: true,
                    sessions: current.map((session) => session.name),
                };
            }
            const mode = input.mode ?? 'launch';
            if (!['launch', 'launchWithArtifact', 'direct'].includes(mode)) {
                throw new Error('Unknown debug mode.');
            }
            if (pendingLaunches.has(folder.uri.fsPath)) {
                throw new Error('A debug launch is already pending in this workspace.');
            }
            pendingLaunches.add(folder.uri.fsPath);
            try {
                const selected =
                    mode === 'direct'
                        ? undefined
                        : selectConfiguration(await configurations(folder), input.configuration);
                let config: vscode.DebugConfiguration;
                if (mode === 'launch') {
                    if (
                        [
                            input.artifactId,
                            input.chip,
                            input.dapServer,
                            input.uploadUrl,
                            input.flash,
                            input.haltAfterReset,
                            input.rttEnabled,
                        ].some((value) => value !== undefined)
                    ) {
                        throw new Error(
                            'launch mode does not accept artifact or hardware overrides.',
                        );
                    }
                    config = structuredClone(selected!);
                } else {
                    if (!input.artifactId) {
                        throw new Error('Specify artifactId from Build Artifact.');
                    }
                    const artifact = await cargo.get(folder.uri.fsPath, input.artifactId);
                    config = artifactDebugConfiguration({...input, mode}, artifact, selected);
                }
                if (token.isCancellationRequested) {
                    throw new Error('Debug launch was cancelled.');
                }
                const started = await vscode.debug.startDebugging(folder, config);
                if (!started) {
                    throw new Error(
                        `VS Code could not start "${selected?.name ?? 'direct launch'}".`,
                    );
                }
                return {
                    success: true,
                    configuration: config.name,
                    mode,
                    message:
                        mode === 'launch'
                            ? 'Debugging started using the existing launch configuration.'
                            : 'Debugging started with the built artifact. preLaunchTask was not executed. This does not establish embedded test pass/fail.',
                };
            } finally {
                pendingLaunches.delete(folder.uri.fsPath);
            }
        },
        async (input) => {
            const folder = resolveWorkspaceFolder(input);
            const mode = input.mode ?? 'launch';
            const base =
                mode === 'direct'
                    ? undefined
                    : selectConfiguration(await configurations(folder), input.configuration);
            const artifact = input.artifactId
                ? await cargo.get(folder.uri.fsPath, input.artifactId)
                : undefined;
            const effective =
                artifact && mode !== 'launch'
                    ? artifactDebugConfiguration({...input, mode}, artifact, base)
                    : base;
            return confirmation(
                'Start Baker Link hardware debugging?',
                `Workspace: ${folder.name}. Mode: ${mode}. Configuration: ${base?.name ?? 'direct'}. Chip: ${effective?.chip ?? 'from launch configuration'}. Connection: ${JSON.stringify(effective?.bakerLink ?? effective?.server)}. Flash/reset: ${JSON.stringify(effective?.flashingConfig)}. ${mode === 'launch' ? 'The configured preLaunchTask is preserved.' : 'preLaunchTask is skipped; the selected artifact is already built.'} This may program or reset hardware.`,
                'Starting Baker Link debugging',
            );
        },
    );

    const debugStatus = new AgentTool<WorkspaceInput>(async (input) => {
        const folder = resolveWorkspaceFolder(input);
        const sessions = bakerLinkSessions(folder);
        return {
            running: sessions.length > 0,
            sessions: sessions.map((session) => ({
                name: session.name,
                type: session.type,
                configuration: session.configuration.name,
            })),
        };
    });

    const stopDebugging = new AgentTool<WorkspaceInput>(
        async (input) => {
            const folder = resolveWorkspaceFolder(input);
            const sessions = bakerLinkSessions(folder);
            if (sessions.length === 0) {
                return {stopped: false, message: 'No active Baker Link debug session found.'};
            }
            for (const session of sessions) {
                await vscode.debug.stopDebugging(session);
            }
            return {stopped: true, sessions: sessions.map((session) => session.name)};
        },
        () =>
            confirmation(
                'Stop Baker Link debugging?',
                'Stop the active Baker Link debug session in the selected workspace.',
                'Stopping Baker Link debugging',
            ),
    );

    const setBreakpoint = new AgentTool<BreakpointInput>(
        async (input) => {
            const folder = resolveWorkspaceFolder(input);
            const target = await resolveBreakpointTarget(folder, input);
            const root = await fs.realpath(folder.uri.fsPath);
            const existing = vscode.debug.breakpoints.find(
                (breakpoint) =>
                    breakpointInWorkspace(breakpoint, root) &&
                    path.resolve(breakpoint.location.uri.fsPath) === target.path &&
                    breakpoint.location.range.start.line === target.line - 1,
            );
            if (existing) {
                return {
                    added: false,
                    alreadyExists: true,
                    path: target.relativePath,
                    line: target.line,
                };
            }
            vscode.debug.addBreakpoints([
                new vscode.SourceBreakpoint(
                    new vscode.Location(
                        vscode.Uri.file(target.path),
                        new vscode.Position(target.line - 1, 0),
                    ),
                ),
            ]);
            return {
                added: true,
                path: target.relativePath,
                line: target.line,
                sourceLine: target.sourceLine,
            };
        },
        async (input) => {
            const folder = resolveWorkspaceFolder(input);
            const target = await resolveBreakpointTarget(folder, input);
            const message = new vscode.MarkdownString();
            message.appendText(
                `Add a breakpoint at ${folder.name} / ${target.relativePath}:${target.line}?\n`,
            );
            message.appendCodeblock(target.sourceLine);
            return {
                invocationMessage: `Setting breakpoint at ${target.relativePath}:${target.line}`,
                confirmationMessages: {title: 'Set source breakpoint?', message},
            };
        },
    );

    const listBreakpoints = new AgentTool<WorkspaceInput>(async (input) => {
        const folder = resolveWorkspaceFolder(input);
        const root = await fs.realpath(folder.uri.fsPath);
        const breakpoints = vscode.debug.breakpoints
            .filter((breakpoint) => breakpointInWorkspace(breakpoint, root))
            .map((breakpoint) => ({
                path: path.relative(root, breakpoint.location.uri.fsPath),
                line: breakpoint.location.range.start.line + 1,
                enabled: breakpoint.enabled,
                ...(breakpoint.condition === undefined ? {} : {condition: breakpoint.condition}),
                ...(breakpoint.hitCondition === undefined
                    ? {}
                    : {hitCondition: breakpoint.hitCondition}),
            }));
        return {breakpoints};
    });

    const removeBreakpoint = new AgentTool<BreakpointInput>(
        async (input) => {
            const folder = resolveWorkspaceFolder(input);
            const target = await resolveBreakpointTarget(folder, input);
            const root = await fs.realpath(folder.uri.fsPath);
            const matches = vscode.debug.breakpoints.filter(
                (breakpoint) =>
                    breakpointInWorkspace(breakpoint, root) &&
                    path.resolve(breakpoint.location.uri.fsPath) === target.path &&
                    breakpoint.location.range.start.line === target.line - 1,
            );
            if (matches.length === 0) {
                return {
                    removed: false,
                    message: `No breakpoint is set at ${target.relativePath}:${target.line}.`,
                };
            }
            vscode.debug.removeBreakpoints(matches);
            return {
                removed: true,
                path: target.relativePath,
                line: target.line,
            };
        },
        (input) =>
            confirmation(
                'Remove source breakpoint?',
                `Remove the breakpoint at **${input.path}:${input.line}**.`,
                `Removing breakpoint at ${input.path}:${input.line}`,
            ),
    );

    return [
        {name: 'inspect_project', register: (id) => vscode.lm.registerTool(id, inspectProject)},
        {name: 'build_artifact', register: (id) => vscode.lm.registerTool(id, buildArtifact)},
        {name: 'run_tests', register: (id) => vscode.lm.registerTool(id, runTests)},
        {name: 'build', register: (id) => vscode.lm.registerTool(id, build)},
        {
            name: 'start_debugging',
            register: (id) => vscode.lm.registerTool(id, startDebugging),
        },
        {name: 'debug_status', register: (id) => vscode.lm.registerTool(id, debugStatus)},
        {name: 'stop_debugging', register: (id) => vscode.lm.registerTool(id, stopDebugging)},
        {name: 'set_breakpoint', register: (id) => vscode.lm.registerTool(id, setBreakpoint)},
        {name: 'list_breakpoints', register: (id) => vscode.lm.registerTool(id, listBreakpoints)},
        {
            name: 'remove_breakpoint',
            register: (id) => vscode.lm.registerTool(id, removeBreakpoint),
        },
    ];
}

export function registerAgentTools(
    context: Pick<vscode.ExtensionContext, 'subscriptions'>,
    cargo = new CargoArtifacts(),
) {
    const active = vscode.debug.activeDebugSession;
    if (active?.type === DEBUG_TYPE) {
        knownDebugSessions.add(active);
    }
    context.subscriptions.push(
        vscode.debug.onDidStartDebugSession((session) => {
            if (session.type === DEBUG_TYPE) {
                knownDebugSessions.add(session);
            }
        }),
        vscode.debug.onDidTerminateDebugSession((session) => {
            knownDebugSessions.delete(session);
        }),
    );
    for (const definition of getTools(cargo)) {
        context.subscriptions.push(definition.register(`${TOOL_PREFIX}${definition.name}`));
    }
}
