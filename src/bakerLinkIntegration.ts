import * as path from 'node:path';
import * as vscode from 'vscode';
import {
    CONNECTION_FILE,
    checkConnection,
    errorMessage,
    isRecord,
    parseArtifactIdentifier,
    readConnection,
    uploadElf,
} from './bakerLink';

export const DEBUG_TYPE = 'baker-link-debug';

function artifactBinaries(config: vscode.DebugConfiguration): string[] {
    const cores: unknown = config.coreConfigs;
    if (!Array.isArray(cores)) {
        return [];
    }
    return cores.flatMap((core: unknown) =>
        isRecord(core) &&
        typeof core.programBinary === 'string' &&
        core.programBinary.startsWith('bakerlink://')
            ? [core.programBinary]
            : [],
    );
}

export class BakerLinkIntegration {
    private readonly output = vscode.window.createOutputChannel('Baker Link Env');
    private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);

    constructor(context: Pick<vscode.ExtensionContext, 'subscriptions'>) {
        this.status.command = 'bakerLink.checkConnection';
        this.resetStatus();
        const watcher = vscode.workspace.createFileSystemWatcher(`**/${CONNECTION_FILE}`);
        context.subscriptions.push(
            this.output,
            this.status,
            watcher,
            watcher.onDidChange(() => this.resetStatus()),
            watcher.onDidCreate(() => this.resetStatus()),
            watcher.onDidDelete(() => this.resetStatus()),
            vscode.workspace.onDidChangeWorkspaceFolders(() => this.resetStatus()),
            vscode.commands.registerCommand('bakerLink.checkConnection', () =>
                this.runCommand(async (folder) => {
                    const connection = await readConnection(folder.uri.fsPath);
                    await vscode.window.withProgress(
                        {
                            location: vscode.ProgressLocation.Notification,
                            title: `Baker Link: Checking ${folder.name}`,
                            cancellable: true,
                        },
                        async (_, token) => {
                            const controller = new AbortController();
                            const subscription = token.onCancellationRequested(() =>
                                controller.abort(),
                            );
                            try {
                                await checkConnection(connection, controller.signal);
                            } finally {
                                subscription.dispose();
                            }
                        },
                    );
                    this.status.text = '$(plug) Baker Link: Ports reachable';
                    this.status.tooltip = `${folder.name}: DAP and ELF upload TCP ports reachable. This does not verify host identity or USB probe readiness.`;
                    this.output.appendLine(
                        `${folder.name}: ${connection.dapServer} and ${connection.uploadUrl} reachable.`,
                    );
                    await vscode.window.showInformationMessage(
                        'Baker Link: DAP and ELF upload ports are reachable (USB probe not checked).',
                    );
                }),
            ),
            vscode.commands.registerCommand('bakerLink.openConnection', () =>
                this.runCommand(async (folder) => {
                    const document = await vscode.workspace.openTextDocument(
                        vscode.Uri.joinPath(folder.uri, CONNECTION_FILE),
                    );
                    await vscode.window.showTextDocument(document);
                }),
            ),
        );
    }

    private resetStatus() {
        this.status.text = '$(debug-disconnect) Baker Link: Check connection';
        this.status.tooltip = 'Check the host DAP and ELF upload ports for a selected workspace.';
        if (vscode.workspace.workspaceFolders?.length) {
            this.status.show();
        } else {
            this.status.hide();
        }
    }

    private requireTrustedWorkspace() {
        if (!vscode.workspace.isTrusted) {
            throw new Error('Trust this workspace before connecting to Baker Link Env.');
        }
    }

    private async runCommand(action: (folder: vscode.WorkspaceFolder) => Promise<void>) {
        try {
            this.requireTrustedWorkspace();
            const folders = vscode.workspace.workspaceFolders ?? [];
            const folder =
                folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
            if (!folder) {
                if (folders.length === 0) {
                    throw new Error('Open a Baker Link project folder first.');
                }
                return;
            }
            await action(folder);
        } catch (error) {
            this.reportError(error);
        }
    }

    reportError(error: unknown) {
        const message = errorMessage(error);
        this.status.text = '$(warning) Baker Link: Check connection';
        this.status.tooltip = message;
        this.output.appendLine(`ERROR: ${message}`);
        void vscode.window.showErrorMessage(
            `Baker Link: ${message} Start Baker Link Env with Run on the host and check connection settings and firewall rules.`,
        );
    }

    async configure(config: vscode.DebugConfiguration, folder?: vscode.WorkspaceFolder) {
        const binaries = artifactBinaries(config);
        if (binaries.length === 0) {
            if (config.bakerLink !== undefined) {
                throw new Error(
                    'bakerLink.elf requires a bakerlink://project/profile programBinary.',
                );
            }
            return;
        }
        this.requireTrustedWorkspace();
        if (!folder) {
            throw new Error('Baker Link artifact debugging requires a workspace folder.');
        }
        for (const binary of binaries) {
            parseArtifactIdentifier(binary);
        }
        if (config.remoteServerMode === true) {
            throw new Error('Baker Link artifacts require remoteServerMode: false.');
        }
        if (
            config.bakerLink !== undefined &&
            (!isRecord(config.bakerLink) ||
                typeof config.bakerLink.elf !== 'string' ||
                !config.bakerLink.elf.trim() ||
                binaries.length !== 1 ||
                config.request !== 'launch')
        ) {
            throw new Error(
                'bakerLink.elf requires a launch session with exactly one artifact URI.',
            );
        }
        const connection = await readConnection(folder.uri.fsPath);
        config.server = connection.dapServer;
        config.remoteServerMode = false;
    }

    async prepareDebug(config: vscode.DebugConfiguration, folder?: vscode.WorkspaceFolder) {
        await this.configure(config, folder);
        if (!folder || !isRecord(config.bakerLink) || typeof config.bakerLink.elf !== 'string') {
            return;
        }
        const connection = await readConnection(folder.uri.fsPath);
        const artifact = parseArtifactIdentifier(artifactBinaries(config)[0]);
        const elf = path.resolve(folder.uri.fsPath, config.bakerLink.elf);
        if (elf.includes('${')) {
            throw new Error('Unresolved VS Code variable in bakerLink.elf.');
        }
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Baker Link: Uploading ${artifact.project}/${artifact.profile}`,
                cancellable: true,
            },
            async (_, token) => {
                const controller = new AbortController();
                const subscription = token.onCancellationRequested(() => controller.abort());
                try {
                    this.output.appendLine(`Uploading ${elf} to ${connection.uploadUrl}`);
                    await uploadElf(connection, artifact, elf, controller.signal);
                    this.output.appendLine(`ELF uploaded: ${artifact.project}/${artifact.profile}`);
                } finally {
                    subscription.dispose();
                }
            },
        );
    }
}
