import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import {createServer, IncomingMessage, ServerResponse} from 'node:http';
import {tmpdir} from 'node:os';
import * as path from 'node:path';
import {test} from 'node:test';
import * as vscode from 'vscode';
import {
    MAX_ARTIFACT_SIZE,
    checkConnection,
    checkPort,
    parseArtifactIdentifier,
    parseConnection,
    parseDapAddress,
    parseUploadUrl,
    readConnection,
    uploadElf,
} from '../src/bakerLink';
import {BakerLinkIntegration, DEBUG_TYPE} from '../src/bakerLinkIntegration';
import {ProbeRsDebugAdapter} from '../src/remoteServer';
import type {DapTransport} from '../src/transport';
import type {DebugProtocol} from '@vscode/debugprotocol';
import {workspace as mockWorkspace} from './vscode';

async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void) {
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const port = address.port;
    return {
        connection: {
            version: 1 as const,
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

test('validates version 1 connection and explicit ports', () => {
    const connection = {
        version: 1,
        dapServer: 'host.docker.internal:50001',
        uploadUrl: 'http://host.docker.internal:50002',
    };
    assert.deepEqual(parseConnection(connection), connection);
    for (const value of [
        null,
        {},
        {...connection, version: 2},
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

test('reports missing and malformed connection files explicitly', async () => {
    const project = await temporaryProject();
    try {
        await assert.rejects(readConnection(project.root), /connection\.json/);
        await fs.mkdir(path.join(project.root, '.bakerlink'));
        await fs.writeFile(path.join(project.root, '.bakerlink/connection.json'), '{');
        await assert.rejects(readConnection(project.root), /Cannot read/);
    } finally {
        await project.close();
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
        bakerLink: {elf: 'firmware.elf'},
    };
    try {
        await fs.mkdir(path.join(project.root, '.bakerlink'));
        await fs.writeFile(
            path.join(project.root, '.bakerlink/connection.json'),
            JSON.stringify(server.connection),
        );
        await integration.configure(config, folder);
        assert.equal(uploads, 0);
        assert.equal(config.server, server.connection.dapServer);
        assert.equal(config.remoteServerMode, false);
        await assert.rejects(integration.prepareDebug(config, folder), /ENOENT/);
        assert.equal(uploads, 0);
        await fs.writeFile(project.elf, 'ELF produced by preLaunchTask');
        await integration.prepareDebug(config, folder);
        assert.equal(uploads, 1);
        assert.deepEqual(config.bakerLink, {elf: 'firmware.elf'});
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
