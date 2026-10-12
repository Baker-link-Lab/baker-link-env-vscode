import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import {createServer, IncomingMessage, ServerResponse} from 'node:http';
import {tmpdir} from 'node:os';
import * as path from 'node:path';
import {test} from 'node:test';
import './cargoArtifacts.test';
import * as vscode from 'vscode';
import {
    MAX_ARTIFACT_SIZE,
    DEFAULT_DAP_SERVER,
    DEFAULT_UPLOAD_URL,
    checkConnection,
    checkPort,
    parseArtifactIdentifier,
    parseConnection,
    parseDapAddress,
    parseUploadUrl,
    connectionFromLaunch,
    uploadElf,
} from '../src/bakerLink';
import {BakerLinkIntegration, DEBUG_TYPE} from '../src/bakerLinkIntegration';
import {registerAgentTools} from '../src/agentTools';
import {CargoArtifacts} from '../src/cargoArtifacts';
import {ProbeRsDebugAdapter} from '../src/remoteServer';
import type {DapTransport} from '../src/transport';
import type {DebugProtocol} from '@vscode/debugprotocol';
import {
    workspace as mockWorkspace,
    window as mockWindow,
    commandHandlers,
    debug as mockDebug,
    messages,
    documents,
    registeredTools,
    tasks as mockTasks,
    taskProcessEnd,
    taskEnd,
    EventEmitter,
} from './vscode';

async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void) {
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const port = address.port;
    return {
        connection: {
            dapServer: `127.0.0.1:${port}`,
            uploadUrl: `http://127.0.0.1:${port}`,
        },
        async close() {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
            );
        },
    };
}

async function temporaryProject() {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'baker-link-vscode-test-'));
    const elf = path.join(root, 'firmware.elf');
    await fs.writeFile(elf, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]));
    return {root, elf, close: () => fs.rm(root, {recursive: true})};
}

test('validates launch connection endpoints and explicit ports', () => {
    const connection = {
        dapServer: 'host.docker.internal:50001',
        uploadUrl: 'http://host.docker.internal:50002',
    };
    assert.deepEqual(parseConnection(connection), connection);
    for (const value of [
        null,
        {},
        {...connection, uploadUrl: 12},
        {...connection, dapServer: 'host'},
    ]) {
        assert.throws(() => parseConnection(value));
    }
});

test('parses DAP hosts and IPv6 without splitting the address', () => {
    assert.deepEqual(parseDapAddress('[::1]:50001'), {host: '::1', port: 50001});
    assert.deepEqual(parseDapAddress('localhost', 50000), {host: 'localhost', port: 50000});
    for (const value of ['host:0', 'host:65536', 'host:-1', 'host:abc', '::1:50001', '[host]:1']) {
        assert.throws(() => parseDapAddress(value));
    }
});

test('rejects unsafe or non-origin upload URLs', () => {
    for (const value of [
        'file:///tmp/elf',
        'http://user:pass@host:50002',
        'http://host/path',
        'http://host/?token=value',
        'http://host/#fragment',
    ]) {
        assert.throws(() => parseUploadUrl(value));
    }
    assert.equal(parseUploadUrl('https://host:50002').origin, 'https://host:50002');
});

test('matches host artifact identifier limits and rejects path traversal', () => {
    assert.deepEqual(parseArtifactIdentifier('bakerlink://my_project-1/debug'), {
        project: 'my_project-1',
        profile: 'debug',
    });
    parseArtifactIdentifier(`bakerlink://${'a'.repeat(80)}/debug`);
    for (const value of [
        'bakerlink://../debug',
        'bakerlink://project/debug/extra',
        'bakerlink://project/',
        `bakerlink://${'a'.repeat(81)}/debug`,
        'bakerlink://project/debug?query',
        'bakerlink://project%2Fescape/debug',
    ]) {
        assert.throws(() => parseArtifactIdentifier(value));
    }
});

test('uses launch endpoints or built-in defaults without connection files', () => {
    assert.deepEqual(connectionFromLaunch({bakerLink: {elf: 'firmware.elf'}}), {
        dapServer: DEFAULT_DAP_SERVER,
        uploadUrl: DEFAULT_UPLOAD_URL,
    });
    assert.deepEqual(
        connectionFromLaunch({
            server: 'legacy-host:50001',
            bakerLink: {dapServer: 'custom-host:60001', uploadUrl: 'https://custom-host:60002'},
        }),
        {dapServer: 'custom-host:60001', uploadUrl: 'https://custom-host:60002'},
    );
    assert.equal(
        connectionFromLaunch({server: 'legacy-host:50001'}).dapServer,
        'legacy-host:50001',
    );
    for (const config of [
        {bakerLink: false},
        {bakerLink: {dapServer: 12}},
        {bakerLink: {dapServer: null}},
        {bakerLink: {uploadUrl: null}},
        {bakerLink: {uploadUrl: 'file:///tmp'}},
        {bakerLink: {dapServer: '${env:HOST}:50001'}},
    ]) {
        assert.throws(() => connectionFromLaunch(config));
    }
});

test('uploads exact bytes and SHA-256 with the existing host protocol', async () => {
    const project = await temporaryProject();
    const body = await fs.readFile(project.elf);
    let received = false;
    const server = await serve((request, response) => {
        assert.equal(request.method, 'PUT');
        assert.equal(request.url, '/v1/artifacts/example/debug');
        assert.equal(request.headers['content-length'], String(body.length));
        assert.equal(request.headers['content-type'], 'application/octet-stream');
        assert.equal(
            request.headers['x-content-sha256'],
            createHash('sha256').update(body).digest('hex'),
        );
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
            assert.deepEqual(Buffer.concat(chunks), body);
            received = true;
            response.writeHead(201).end('ELF uploaded');
        });
    });
    try {
        await uploadElf(server.connection, {project: 'example', profile: 'debug'}, project.elf);
        assert.equal(received, true);
    } finally {
        await server.close();
        await project.close();
    }
});

test('rejects HTTP failures and unexpected success codes', async () => {
    const project = await temporaryProject();
    for (const code of [400, 200, 302, 500]) {
        const server = await serve((request, response) => {
            request.resume();
            response.writeHead(code).end('Host rejected artifact');
        });
        try {
            await assert.rejects(
                uploadElf(server.connection, {project: 'example', profile: 'debug'}, project.elf),
                new RegExp(`HTTP ${code}.*Host rejected artifact`),
            );
        } finally {
            await server.close();
        }
    }
    await project.close();
});

test('times out stalled uploads and propagates cancellation', async () => {
    const project = await temporaryProject();
    const server = await serve((request) => request.resume());
    try {
        await assert.rejects(
            uploadElf(
                server.connection,
                {project: 'example', profile: 'debug'},
                project.elf,
                undefined,
                30,
            ),
            /timed out/,
        );
        const controller = new AbortController();
        const upload = uploadElf(
            server.connection,
            {project: 'example', profile: 'debug'},
            project.elf,
            controller.signal,
        );
        setTimeout(() => controller.abort(), 30);
        await assert.rejects(upload, /abort/i);
    } finally {
        await server.close();
        await project.close();
    }
});

test('rejects oversized response bodies', async () => {
    const project = await temporaryProject();
    const server = await serve((request, response) => {
        request.resume();
        response.writeHead(201).end('x'.repeat(70 * 1024));
    });
    try {
        await assert.rejects(
            uploadElf(server.connection, {project: 'example', profile: 'debug'}, project.elf),
            /exceeds 64 KiB/,
        );
    } finally {
        await server.close();
        await project.close();
    }
});

test('rejects missing, empty, and over-limit ELF files before sending', async () => {
    const project = await temporaryProject();
    const connection = parseConnection({
        version: 1,
        dapServer: 'localhost:1',
        uploadUrl: 'http://localhost:1',
    });
    try {
        await assert.rejects(
            uploadElf(connection, {project: 'example', profile: 'debug'}, `${project.elf}.missing`),
            /ENOENT/,
        );
        await fs.truncate(project.elf, 0);
        await assert.rejects(
            uploadElf(connection, {project: 'example', profile: 'debug'}, project.elf),
            /non-empty/,
        );
        await fs.truncate(project.elf, MAX_ARTIFACT_SIZE + 1);
        await assert.rejects(
            uploadElf(connection, {project: 'example', profile: 'debug'}, project.elf),
            /128 MiB/,
        );
    } finally {
        await project.close();
    }
});

test('checks both TCP endpoints and reports unreachable ports', async () => {
    const server = await serve((_, response) => response.end());
    try {
        await checkConnection(server.connection);
        const aborted = new AbortController();
        aborted.abort();
        await assert.rejects(checkPort('127.0.0.1', 1, aborted.signal), /abort/i);
    } finally {
        await server.close();
    }
    await assert.rejects(checkConnection(server.connection), /ECONNREFUSED/);
});

test('configuration does not upload before the build; adapter preparation uploads afterwards', async () => {
    const project = await temporaryProject();
    await fs.unlink(project.elf);
    let uploads = 0;
    const server = await serve((request, response) => {
        request.resume();
        request.on('end', () => {
            uploads++;
            response.writeHead(201).end('ELF uploaded');
        });
    });
    const folder: vscode.WorkspaceFolder = {
        uri: vscode.Uri.file(project.root),
        name: 'example',
        index: 0,
    };
    const integration = new BakerLinkIntegration({subscriptions: []});
    const config: vscode.DebugConfiguration = {
        type: DEBUG_TYPE,
        request: 'launch',
        name: 'Example',
        server: 'stale-host:1234',
        coreConfigs: [{coreIndex: 0, programBinary: 'bakerlink://example/debug'}],
        bakerLink: {elf: 'firmware.elf', ...server.connection},
    };
    try {
        await assert.rejects(fs.stat(path.join(project.root, '.bakerlink')), /ENOENT/);
        await integration.configure(config, folder);
        assert.equal(uploads, 0);
        assert.equal(config.server, server.connection.dapServer);
        assert.equal(config.remoteServerMode, false);
        await assert.rejects(integration.prepareDebug(config, folder), /ENOENT/);
        assert.equal(uploads, 0);
        await fs.writeFile(project.elf, 'ELF produced by preLaunchTask');
        await integration.prepareDebug(config, folder);
        assert.equal(uploads, 1);
        assert.deepEqual(config.bakerLink, {elf: 'firmware.elf', ...server.connection});
        assert.equal(config.coreConfigs[0].programBinary, 'bakerlink://example/debug');
        await integration.prepareDebug(config, folder);
        assert.equal(uploads, 2, 'restarts must upload the newly built ELF again');
        delete config.bakerLink;
        await integration.prepareDebug(config, folder);
        assert.equal(uploads, 2, 'legacy shell-upload sessions must not upload again');
    } finally {
        await server.close();
        await project.close();
    }
});

test('restart waits for upload and does not forward a restart when upload fails', async () => {
    const writes: Buffer[] = [];
    const transport: DapTransport = {
        description: 'test',
        start() {},
        write: (data) => writes.push(data),
        dispose() {},
    };
    let completeUpload: (() => void) | undefined;
    const adapter = new ProbeRsDebugAdapter(
        transport,
        {entries: []},
        () => new Promise<void>((resolve) => (completeUpload = resolve)),
    );
    const request: DebugProtocol.Request = {type: 'request', seq: 7, command: 'restart'};
    adapter.handleMessage(request);
    assert.equal(writes.length, 0);
    assert.ok(completeUpload);
    completeUpload();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(writes.length, 1);
    assert.match(writes[0].toString(), /"command":"restart"/);
    adapter.dispose();

    const failed = new ProbeRsDebugAdapter(transport, {entries: []}, async () => {
        throw new Error('Upload failed');
    });
    const responses: vscode.DebugProtocolMessage[] = [];
    failed.onDidSendMessage((message) => responses.push(message));
    failed.handleMessage(request);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(writes.length, 1);
    assert.deepEqual(responses[0], {
        type: 'response',
        seq: 0,
        request_seq: 7,
        command: 'restart',
        success: false,
        message: 'Upload failed',
    });
    failed.dispose();
});

test('standard sessions preserve DAP framing without a Baker Link restart hook', () => {
    const writes: Buffer[] = [];
    const transport: DapTransport = {
        description: 'test',
        start() {},
        write: (data) => writes.push(data),
        dispose() {},
    };
    const adapter = new ProbeRsDebugAdapter(transport, {entries: []});
    const request: DebugProtocol.Request = {type: 'request', seq: 1, command: 'restart'};
    adapter.handleMessage(request);
    const json = JSON.stringify(request);
    assert.equal(
        writes[0].toString(),
        `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`,
    );
    adapter.dispose();
});

test('rejects untrusted, incompatible, and ambiguous artifact configurations', async () => {
    const integration = new BakerLinkIntegration({subscriptions: []});
    const folder: vscode.WorkspaceFolder = {
        uri: vscode.Uri.file('/tmp'),
        name: 'example',
        index: 0,
    };
    const config: vscode.DebugConfiguration = {
        type: DEBUG_TYPE,
        request: 'launch',
        name: 'Example',
        coreConfigs: [{programBinary: 'bakerlink://example/debug'}],
        bakerLink: {elf: 'firmware.elf'},
    };
    await assert.rejects(integration.configure(config), /workspace folder/);
    await assert.rejects(
        integration.configure({...config, remoteServerMode: true}, folder),
        /remoteServerMode: false/,
    );
    await assert.rejects(
        integration.configure(
            {...config, coreConfigs: [...config.coreConfigs, ...config.coreConfigs]},
            folder,
        ),
        /exactly one/,
    );
    await assert.rejects(
        integration.configure({...config, request: 'attach'}, folder),
        /launch session/,
    );
    mockWorkspace.isTrusted = false;
    try {
        await assert.rejects(integration.configure(config, folder), /Trust this workspace/);
    } finally {
        mockWorkspace.isTrusted = true;
    }
    const normal: vscode.DebugConfiguration = {
        ...config,
        coreConfigs: [{programBinary: 'firmware.elf'}],
    };
    delete normal.bakerLink;
    await integration.configure(normal, folder);
    assert.equal(normal.server, undefined, 'standard local configurations are unchanged');
});

test('diagnostics select launch configurations and open launch.json without .bakerlink', async () => {
    const project = await temporaryProject();
    const server = await serve((_, response) => response.end());
    const folder: vscode.WorkspaceFolder = {
        uri: vscode.Uri.file(project.root),
        name: 'example',
        index: 0,
    };
    new BakerLinkIntegration({subscriptions: []});
    mockWorkspace.workspaceFolders = [folder];
    mockWorkspace.configurations.set(project.root, [
        {type: 'other-debugger', name: 'Other'},
        {type: DEBUG_TYPE, name: 'Unavailable', bakerLink: {dapServer: 'invalid'}},
        {type: DEBUG_TYPE, name: 'Reachable', bakerLink: server.connection},
    ]);
    mockWindow.selectedIndex = 1;
    try {
        const check = commandHandlers.get('bakerLink.checkConnection');
        const open = commandHandlers.get('bakerLink.openConnection');
        assert.ok(check && open);
        const before = messages.length;
        await check();
        assert.match(messages[before], /ports are reachable/);
        await open();
        assert.equal(documents.at(-1)?.fsPath, path.join(project.root, '.vscode/launch.json'));
        await assert.rejects(fs.stat(path.join(project.root, '.bakerlink')), /ENOENT/);
        mockWorkspace.configurations.set(project.root, []);
        await check();
        assert.match(messages.at(-1) ?? '', /Add a Baker Link debug configuration/);
    } finally {
        mockWindow.selectedIndex = 0;
        mockWorkspace.workspaceFolders = [];
        mockWorkspace.configurations.clear();
        await server.close();
        await project.close();
    }
});

test('invalid launch endpoints abort preparation without uploading', async () => {
    const project = await temporaryProject();
    const integration = new BakerLinkIntegration({subscriptions: []});
    const folder: vscode.WorkspaceFolder = {
        uri: vscode.Uri.file(project.root),
        name: 'example',
        index: 0,
    };
    const config: vscode.DebugConfiguration = {
        type: DEBUG_TYPE,
        request: 'launch',
        name: 'Example',
        bakerLink: {elf: project.elf, dapServer: 'localhost:0'},
        coreConfigs: [{programBinary: 'bakerlink://example/debug'}],
    };
    try {
        await assert.rejects(integration.prepareDebug(config, folder), /dapServer/);
        config.bakerLink = {elf: project.elf, uploadUrl: 'http://localhost/path'};
        await assert.rejects(integration.prepareDebug(config, folder), /uploadUrl/);
    } finally {
        await project.close();
    }
});

test('Agent breakpoint tools stay inside the workspace and target exact source lines', async () => {
    const project = await temporaryProject();
    const source = path.join(project.root, 'main.rs');
    const outside = path.join(
        path.dirname(project.root),
        `${path.basename(project.root)}-outside.rs`,
    );
    const sourceText = 'fn main() {\n    let value = 42;\n}\n';
    await fs.writeFile(source, sourceText);
    await fs.writeFile(outside, 'fn outside() {}\n');
    mockWorkspace.documentText.set(source, sourceText);
    mockWorkspace.workspaceFolders = [
        {uri: vscode.Uri.file(project.root), name: 'example', index: 0},
    ];
    mockDebug.breakpoints = [];
    registerAgentTools({subscriptions: []});

    const invoke = async (name: string, input: unknown) => {
        const tool = registeredTools.get(`baker-link-env_${name}`);
        assert.ok(tool, `Expected registered tool ${name}`);
        const result = (await tool.invoke(
            {input, toolInvocationToken: undefined},
            {isCancellationRequested: false},
        )) as {content: Array<{value: string}>};
        assert.equal(result.content.length, 1);
        assert.ok(result.content[0] instanceof vscode.LanguageModelTextPart);
        return JSON.parse(result.content[0].value);
    };

    try {
        const tool = registeredTools.get('baker-link-env_set_breakpoint');
        const prepared = (await tool?.prepareInvocation?.({
            input: {path: 'main.rs', line: 2},
        })) as vscode.PreparedToolInvocation;
        assert.ok(prepared.confirmationMessages);
        assert.match(
            String((prepared.confirmationMessages.message as vscode.MarkdownString).value),
            /let value = 42/,
        );
        assert.equal(mockDebug.breakpoints.length, 0, 'preparation does not add breakpoints');
        assert.deepEqual(await invoke('set_breakpoint', {path: 'main.rs', line: 2}), {
            added: true,
            path: 'main.rs',
            line: 2,
            sourceLine: '    let value = 42;',
        });

        assert.deepEqual(await invoke('set_breakpoint', {path: source, line: 2}), {
            added: false,
            alreadyExists: true,
            path: 'main.rs',
            line: 2,
        });
        assert.deepEqual(await invoke('list_breakpoints', {}), {
            breakpoints: [{path: 'main.rs', line: 2, enabled: true}],
        });
        await assert.rejects(invoke('set_breakpoint', {path: source, line: 5}), /outside main\.rs/);
        await assert.rejects(
            invoke('set_breakpoint', {path: outside, line: 1}),
            /inside the selected workspace/,
        );
        assert.deepEqual(await invoke('remove_breakpoint', {path: 'main.rs', line: 2}), {
            removed: true,
            path: 'main.rs',
            line: 2,
        });
        assert.deepEqual(await invoke('list_breakpoints', {}), {breakpoints: []});
    } finally {
        mockDebug.breakpoints = [];
        mockWorkspace.workspaceFolders = [];
        mockWorkspace.documentText.clear();
        await fs.rm(outside, {force: true});
        await project.close();
    }
});

const agentToken: vscode.CancellationToken = {
    isCancellationRequested: false,
    onCancellationRequested: () => ({dispose() {}}),
};

async function invokeAgent(
    name: string,
    input: unknown,
    token: vscode.CancellationToken = agentToken,
) {
    const tool = registeredTools.get(`baker-link-env_${name}`);
    assert.ok(tool, `Expected registered tool ${name}`);
    const result = (await tool.invoke({input, toolInvocationToken: undefined}, token)) as {
        content: Array<{value: string}>;
    };
    assert.equal(result.content.length, 1);
    assert.ok(result.content[0] instanceof vscode.LanguageModelTextPart);
    return JSON.parse(result.content[0].value);
}

test('Agent build tools use execution identity and report process outcomes', async () => {
    const folder: vscode.WorkspaceFolder = {
        uri: vscode.Uri.file(tmpdir()),
        name: 'example',
        index: 0,
    };
    const subscriptions: vscode.Disposable[] = [];
    registerAgentTools({subscriptions});
    mockWorkspace.workspaceFolders = [folder];
    const fetchTasks = mockTasks.fetchTasks;
    const executeTask = mockTasks.executeTask;
    try {
        for (const [mode, label] of [
            ['debug', 'cargo: build'],
            ['release', 'cargo: build (release)'],
            ['check', 'cargo: check'],
        ]) {
            const task = new vscode.Task({type: 'shell'}, folder, label, 'Workspace');
            mockTasks.fetchTasks = async () => [task];
            mockTasks.executeTask = async (selected) => {
                assert.equal(selected, task);
                const execution: vscode.TaskExecution = {
                    task: new vscode.Task({type: 'shell'}, folder, label, 'Workspace'),
                    terminate() {},
                };
                taskProcessEnd.fire({execution, exitCode: 0});
                taskEnd.fire({execution});
                return execution;
            };
            assert.deepEqual(await invokeAgent('build', {mode}), {
                success: true,
                task: label,
                exitCode: 0,
            });
        }
        const task = new vscode.Task({type: 'shell'}, folder, 'cargo: build', 'Workspace');
        mockTasks.fetchTasks = async () => [task];
        for (const exitCode of [1, undefined]) {
            mockTasks.executeTask = async () => {
                const execution: vscode.TaskExecution = {task, terminate() {}};
                setImmediate(() => taskProcessEnd.fire({execution, exitCode}));
                return execution;
            };
            await assert.rejects(
                invokeAgent('build', {mode: 'debug'}),
                exitCode === undefined ? /terminated/ : /exit code 1/,
            );
        }
        mockTasks.executeTask = async () => {
            const execution: vscode.TaskExecution = {task, terminate() {}};
            taskEnd.fire({execution});
            return execution;
        };
        await assert.rejects(invokeAgent('build', {mode: 'debug'}), /without reporting/);
        mockTasks.executeTask = async () => {
            throw new Error('Could not spawn task');
        };
        await assert.rejects(invokeAgent('build', {mode: 'debug'}), /Could not spawn task/);
        mockTasks.taskExecutions = [{task, terminate() {}}];
        await assert.rejects(invokeAgent('build', {mode: 'debug'}), /already running/);
        mockTasks.taskExecutions = [];
        task.isBackground = true;
        await assert.rejects(invokeAgent('build', {mode: 'debug'}), /non-background/);
        task.isBackground = false;
        mockTasks.fetchTasks = async () => [];
        await assert.rejects(invokeAgent('build', {mode: 'debug'}), /not configured/);
        await assert.rejects(invokeAgent('build', {mode: 'clean'}), /Unsupported build mode/);
    } finally {
        subscriptions.forEach((subscription) => subscription.dispose());
        mockTasks.fetchTasks = fetchTasks;
        mockTasks.executeTask = executeTask;
        mockTasks.taskExecutions = [];
        mockWorkspace.workspaceFolders = [];
    }
});

test('Agent build cancellation terminates only its own task execution', async () => {
    const folder: vscode.WorkspaceFolder = {
        uri: vscode.Uri.file(tmpdir()),
        name: 'example',
        index: 0,
    };
    const subscriptions: vscode.Disposable[] = [];
    registerAgentTools({subscriptions});
    mockWorkspace.workspaceFolders = [folder];
    const fetchTasks = mockTasks.fetchTasks;
    const executeTask = mockTasks.executeTask;
    const cancellation = new EventEmitter<void>();
    const token = {
        isCancellationRequested: false,
        onCancellationRequested: cancellation.event,
    };
    let terminated = false;
    try {
        const task = new vscode.Task({type: 'shell'}, folder, 'cargo: build', 'Workspace');
        mockTasks.fetchTasks = async () => [task];
        mockTasks.executeTask = async () => {
            const execution: vscode.TaskExecution = {
                task,
                terminate() {
                    terminated = true;
                    taskProcessEnd.fire({execution, exitCode: undefined});
                },
            };
            setImmediate(() => {
                token.isCancellationRequested = true;
                cancellation.fire();
            });
            return execution;
        };
        await assert.rejects(invokeAgent('build', {mode: 'debug'}, token), /cancelled/);
        assert.equal(terminated, true);
    } finally {
        subscriptions.forEach((subscription) => subscription.dispose());
        mockTasks.fetchTasks = fetchTasks;
        mockTasks.executeTask = executeTask;
        mockWorkspace.workspaceFolders = [];
        cancellation.dispose();
    }
});

test('Agent tools reject untrusted and ambiguous workspaces and launch existing configs only', async () => {
    const folder: vscode.WorkspaceFolder = {
        uri: vscode.Uri.file(tmpdir()),
        name: 'example',
        index: 0,
    };
    const subscriptions: vscode.Disposable[] = [];
    registerAgentTools({subscriptions});
    mockWorkspace.workspaceFolders = [folder];
    const startDebugging = mockDebug.startDebugging;
    const stopDebugging = mockDebug.stopDebugging;
    try {
        mockWorkspace.isTrusted = false;
        await assert.rejects(invokeAgent('debug_status', {}), /Trust this workspace/);
        mockWorkspace.isTrusted = true;
        mockWorkspace.workspaceFolders = [folder, {...folder, index: 1, name: 'other'}];
        await assert.rejects(invokeAgent('debug_status', {}), /Specify workspaceFolder/);
        mockWorkspace.workspaceFolders = [folder];
        await assert.rejects(invokeAgent('start_debugging', {}), /No Baker Link launch/);
        mockWorkspace.configurations.set(folder.uri.fsPath, [
            {name: 'Baker Link: Debug', type: DEBUG_TYPE, request: 'launch'},
            {name: 'Unrelated', type: 'other', request: 'launch'},
        ]);
        let started = 0;
        mockDebug.startDebugging = async (selectedFolder, name) => {
            assert.equal(selectedFolder, folder);
            assert.ok(typeof name === 'object');
            assert.equal(name.name, 'Baker Link: Debug');
            started++;
            return true;
        };
        await invokeAgent('start_debugging', {});
        assert.equal(started, 1);
        await assert.rejects(
            invokeAgent('start_debugging', {configuration: 'Unrelated'}),
            /Specify configuration/,
        );
        mockDebug.startDebugging = async () => false;
        await assert.rejects(invokeAgent('start_debugging', {}), /could not start/);
        const session: vscode.DebugSession = {
            id: 'test-session',
            name: 'Baker Link: Debug',
            type: DEBUG_TYPE,
            workspaceFolder: folder,
            configuration: {name: 'Baker Link: Debug', type: DEBUG_TYPE, request: 'launch'},
            customRequest: async () => undefined,
            getDebugProtocolBreakpoint: async () => undefined,
        };
        mockDebug.activeDebugSession = session;
        assert.deepEqual(await invokeAgent('debug_status', {}), {
            running: true,
            sessions: [{name: session.name, type: DEBUG_TYPE, configuration: session.name}],
        });

        assert.deepEqual(await invokeAgent('start_debugging', {}), {
            success: true,
            alreadyRunning: true,
            sessions: [session.name],
        });
        let stopped: vscode.DebugSession | undefined;
        mockDebug.stopDebugging = async (selected) => {
            stopped = selected;
        };
        await invokeAgent('stop_debugging', {});
        assert.equal(stopped, session);
        mockDebug.activeDebugSession = {...session, type: 'other-debugger'};
        assert.deepEqual(await invokeAgent('debug_status', {}), {
            running: false,
            sessions: [],
        });
        assert.deepEqual(await invokeAgent('stop_debugging', {}), {
            stopped: false,
            message: 'No active Baker Link debug session found.',
        });
    } finally {
        subscriptions.forEach((subscription) => subscription.dispose());
        mockWorkspace.isTrusted = true;
        mockWorkspace.workspaceFolders = [];
        mockWorkspace.configurations.clear();
        mockDebug.activeDebugSession = undefined;
        mockDebug.startDebugging = startDebugging;
        mockDebug.stopDebugging = stopDebugging;
    }
});

test('Agent debug modes read freshly saved JSONC launch settings and never modify them', async () => {
    const project = await temporaryProject();
    const folder: vscode.WorkspaceFolder = {
        uri: vscode.Uri.file(project.root),
        name: 'example',
        index: 0,
    };
    const subscriptions: vscode.Disposable[] = [];
    const launchFile = path.join(project.root, '.vscode', 'launch.json');
    const launchText = `{
                // freshly added setting, not yet present in the VS Code configuration cache
                "configurations": [{
                    "name": "ADC Audio", "type": "${DEBUG_TYPE}", "request": "launch",
                    "chip": "RP2040", "preLaunchTask": "cargo: build",
                    "bakerLink": {"dapServer": "host:50001", "uploadUrl": "http://host:50002"},
                    "coreConfigs": [{"coreIndex": 0, "programBinary": "bakerlink://main/debug",}],
                },],
            }`;
    await fs.mkdir(path.dirname(launchFile));
    await fs.writeFile(launchFile, launchText);
    const cargo = new CargoArtifacts(async () => ({
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify({
            reason: 'compiler-artifact',
            executable: project.elf,
            target: {name: 'adc', kind: ['example']},
            package_id: 'firmware',
        }),
    }));
    registerAgentTools({subscriptions}, cargo);
    mockWorkspace.workspaceFolders = [folder];
    const originalStart = mockDebug.startDebugging;
    const launches: Array<string | vscode.DebugConfiguration> = [];
    mockDebug.startDebugging = async (_, config) => {
        launches.push(config);
        return true;
    };
    try {
        await invokeAgent('start_debugging', {mode: 'launch', configuration: 'ADC Audio'});
        const standard = launches.at(-1);
        assert.ok(typeof standard === 'object');
        assert.equal(standard.name, 'ADC Audio');
        assert.equal(standard.preLaunchTask, 'cargo: build');
        const result = await cargo.build(
            project.root,
            {kind: 'example', name: 'adc'},
            new AbortController().signal,
        );
        assert.ok(result.artifact);
        await invokeAgent('start_debugging', {
            mode: 'launchWithArtifact',
            configuration: 'ADC Audio',
            artifactId: result.artifact.artifactId,
        });
        const inherited = launches.at(-1);
        assert.ok(typeof inherited === 'object');
        assert.equal(inherited.chip, 'RP2040');
        assert.equal(inherited.preLaunchTask, undefined);
        assert.equal(inherited.bakerLink.elf, project.elf);
        await invokeAgent('start_debugging', {
            mode: 'direct',
            artifactId: result.artifact.artifactId,
            chip: 'RP2040',
            dapServer: 'host:50001',
            uploadUrl: 'http://host:50002',
            flash: false,
        });
        const direct = launches.at(-1);
        assert.ok(typeof direct === 'object');
        assert.equal(direct.flashingConfig.flashingEnabled, false);
        assert.equal(await fs.readFile(launchFile, 'utf8'), launchText);
        await fs.writeFile(launchFile, '{"configurations": [');
        await assert.rejects(
            invokeAgent('start_debugging', {configuration: 'ADC Audio'}),
            /Invalid.*launch.json/,
        );
    } finally {
        subscriptions.forEach((subscription) => subscription.dispose());
        mockDebug.startDebugging = originalStart;
        mockWorkspace.workspaceFolders = [];
        await project.close();
    }
});
