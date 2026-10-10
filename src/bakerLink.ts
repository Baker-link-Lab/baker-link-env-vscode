import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import {createConnection, isIP} from 'node:net';
import * as path from 'node:path';

export const MAX_ARTIFACT_SIZE = 128 * 1024 * 1024;
export const CONNECTION_FILE = '.bakerlink/connection.json';

export interface BakerLinkConnection {
    version: 1;
    dapServer: string;
    uploadUrl: string;
}

export interface ArtifactIdentifier {
    project: string;
    profile: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseDapAddress(value: string, defaultPort?: number) {
    const match = /^(?:\[([^\]]+)\]|([^:\s/]+))(?::([0-9]+))?$/.exec(value);
    const port = match?.[3] ? Number(match[3]) : defaultPort;
    if (
        !match ||
        !port ||
        port < 1 ||
        port > 65535 ||
        !Number.isInteger(port) ||
        (match[1] !== undefined && isIP(match[1]) !== 6)
    ) {
        throw new Error(
            'dapServer must be host:port (or [IPv6]:port), with a port from 1 to 65535.',
        );
    }
    return {host: match[1] ?? match[2], port};
}

export function parseUploadUrl(value: string): URL {
    const url = new URL(value);
    if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/'
    ) {
        throw new Error('uploadUrl must be an HTTP(S) origin without credentials, path, or query.');
    }
    return url;
}

export function parseConnection(value: unknown): BakerLinkConnection {
    if (
        !isRecord(value) ||
        value.version !== 1 ||
        typeof value.dapServer !== 'string' ||
        typeof value.uploadUrl !== 'string'
    ) {
        throw new Error('Expected connection version 1 with dapServer and uploadUrl strings.');
    }
    parseDapAddress(value.dapServer);
    parseUploadUrl(value.uploadUrl);
    return {version: 1, dapServer: value.dapServer, uploadUrl: value.uploadUrl};
}

export async function readConnection(workspace: string): Promise<BakerLinkConnection> {
    const file = path.join(workspace, CONNECTION_FILE);
    try {
        return parseConnection(JSON.parse(await fs.readFile(file, 'utf8')));
    } catch (error) {
        throw new Error(`Cannot read ${file}: ${errorMessage(error)}`);
    }
}

export function parseArtifactIdentifier(value: string): ArtifactIdentifier {
    const match = /^bakerlink:\/\/([A-Za-z0-9_-]{1,80})\/([A-Za-z0-9_-]{1,80})$/.exec(value);
    if (!match) {
        throw new Error(
            'programBinary must be bakerlink://project/profile with valid identifiers.',
        );
    }
    return {project: match[1], profile: match[2]};
}

export function checkPort(
    host: string,
    port: number,
    signal?: AbortSignal,
    timeoutMs = 3000,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const socket = createConnection({host, port, signal});
        const timer = setTimeout(() => {
            socket.destroy(new Error(`Connection to ${host}:${port} timed out.`));
        }, timeoutMs);
        socket.once('connect', () => {
            socket.destroy();
            resolve();
        });
        socket.once('error', reject);
        socket.once('close', () => clearTimeout(timer));
    });
}

export async function checkConnection(connection: BakerLinkConnection, signal?: AbortSignal) {
    const dap = parseDapAddress(connection.dapServer);
    const upload = parseUploadUrl(connection.uploadUrl);
    // These are reachability checks, not host readiness or USB probe detection.
    await checkPort(dap.host, dap.port, signal);
    await checkPort(
        upload.hostname.replace(/^\[|\]$/g, ''),
        Number(upload.port || (upload.protocol === 'https:' ? 443 : 80)),
        signal,
    );
}

export async function uploadElf(
    connection: BakerLinkConnection,
    artifact: ArtifactIdentifier,
    elfPath: string,
    signal?: AbortSignal,
    timeoutMs = 30000,
): Promise<void> {
    parseArtifactIdentifier(`bakerlink://${artifact.project}/${artifact.profile}`);
    signal?.throwIfAborted();
    const stat = await fs.stat(elfPath);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_ARTIFACT_SIZE) {
        throw new Error(`ELF must be a non-empty file no larger than 128 MiB: ${elfPath}`);
    }
    const body = await fs.readFile(elfPath, {signal});
    if (body.length === 0 || body.length > MAX_ARTIFACT_SIZE) {
        throw new Error(`ELF size changed or exceeds 128 MiB: ${elfPath}`);
    }
    signal?.throwIfAborted();
    const checksum = createHash('sha256').update(body).digest('hex');
    const url = new URL(
        `/v1/artifacts/${artifact.project}/${artifact.profile}`,
        parseUploadUrl(connection.uploadUrl),
    );
    let timer: NodeJS.Timeout | undefined;
    try {
        await new Promise<void>((resolve, reject) => {
            const request = (url.protocol === 'https:' ? https : http).request(
                url,
                {
                    method: 'PUT',
                    signal,
                    headers: {
                        ['Content-Type']: 'application/octet-stream',
                        ['Content-Length']: body.length,
                        ['X-Content-SHA256']: checksum,
                    },
                },
                (response) => {
                    const chunks: Buffer[] = [];
                    let received = 0;
                    response.on('data', (chunk: Buffer) => {
                        received += chunk.length;
                        if (received > 64 * 1024) {
                            request.destroy(new Error('Upload response exceeds 64 KiB.'));
                        } else {
                            chunks.push(chunk);
                        }
                    });
                    response.once('error', reject);
                    response.once('end', () => {
                        if (response.statusCode !== 201) {
                            reject(
                                new Error(
                                    `ELF upload rejected (HTTP ${response.statusCode}): ${Buffer.concat(chunks).toString('utf8')}`,
                                ),
                            );
                        } else {
                            resolve();
                        }
                    });
                },
            );
            timer = setTimeout(
                () => request.destroy(new Error(`ELF upload timed out after ${timeoutMs} ms.`)),
                timeoutMs,
            );
            request.once('error', reject);
            request.end(body);
        });
    } finally {
        clearTimeout(timer);
    }
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
