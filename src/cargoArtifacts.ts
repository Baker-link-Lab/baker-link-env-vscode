import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import * as fs from 'node:fs/promises';
import {isRecord, MAX_ARTIFACT_SIZE} from './bakerLink';

export interface CargoInput {
    package?: string;
    kind: 'bin' | 'example' | 'test' | 'lib';
    name?: string;
    profile?: 'debug' | 'release';
    features?: string[];
    noDefaultFeatures?: boolean;
    targetTriple?: string;
    testFilter?: string;
}

interface CommandResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

export type CargoRunner = (
    args: string[],
    cwd: string,
    signal: AbortSignal,
) => Promise<CommandResult>;

export const runCargo: CargoRunner = (args, cwd, signal) =>
    new Promise((resolve, reject) => {
        signal.throwIfAborted();
        const child = spawn('cargo', args, {cwd, shell: false, windowsHide: true, signal});
        let stdout = '';
        let stderr = '';
        let size = 0;
        let failure: Error | undefined;
        const stop = (error: Error) => {
            failure = error;
            child.kill();
        };
        const timer = setTimeout(
            () => stop(new Error('Cargo exceeded the 10-minute operation timeout.')),
            10 * 60 * 1000,
        );
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        const append = (chunk: string, destination: 'stdout' | 'stderr') => {
            size += Buffer.byteLength(chunk, 'utf8');
            if (size > 16 * 1024 * 1024) {
                stop(new Error('Cargo output exceeded the 16 MiB limit.'));
                return;
            }
            if (destination === 'stdout') {
                stdout += chunk;
            } else {
                stderr += chunk;
            }
        };
        child.stdout.on('data', (chunk: string) => append(chunk, 'stdout'));
        child.stderr.on('data', (chunk: string) => append(chunk, 'stderr'));
        child.once('error', (error) => {
            failure = error;
        });
        child.once('close', (exitCode) => {
            clearTimeout(timer);
            if (signal.aborted) {
                reject(new Error('Cargo operation was cancelled.'));
            } else if (failure) {
                reject(failure);
            } else if (exitCode === null) {
                reject(new Error('Cargo terminated without an exit code.'));
            } else {
                resolve({stdout, stderr, exitCode});
            }
        });
    });

function identifier(value: string, label: string) {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value)) {
        throw new Error(`${label} must be a Cargo identifier, not a path or option.`);
    }
    return value;
}

export function cargoArguments(input: CargoInput, hostTest = false): string[] {
    if (!['bin', 'example', 'test', 'lib'].includes(input.kind)) {
        throw new Error('kind must be bin, example, test, or lib.');
    }
    if (input.profile !== undefined && !['debug', 'release'].includes(input.profile)) {
        throw new Error('profile must be debug or release.');
    }
    if (input.kind === 'lib' && input.name !== undefined) {
        throw new Error('Library targets do not accept name.');
    }
    if (input.kind !== 'lib' && !input.name) {
        throw new Error('Specify name for a binary, example, or integration-test target.');
    }
    if (hostTest && input.kind === 'example') {
        throw new Error('Host test execution supports lib, bin, and test targets.');
    }
    const args = [hostTest || input.kind === 'test' || input.kind === 'lib' ? 'test' : 'build'];
    if (!hostTest && args[0] === 'test') {
        args.push('--no-run');
    }
    if (!hostTest) {
        args.push('--message-format=json');
    }
    args.push('--manifest-path', 'Cargo.toml');
    if (input.package) {
        args.push('--package', identifier(input.package, 'package'));
    }
    args.push(`--${input.kind}`);
    if (input.kind !== 'lib') {
        args.push(identifier(input.name!, 'name'));
    }
    if (input.profile === 'release') {
        args.push('--release');
    }
    if (input.features?.length) {
        args.push(
            '--features',
            input.features
                .map((feature) => {
                    if (!/^[A-Za-z0-9_][A-Za-z0-9_.\/-]*$/.test(feature)) {
                        throw new Error(
                            'features must contain Cargo feature names, not command options.',
                        );
                    }
                    return feature;
                })
                .join(','),
        );
    }
    if (input.noDefaultFeatures) {
        args.push('--no-default-features');
    }
    if (input.targetTriple) {
        args.push('--target', identifier(input.targetTriple, 'targetTriple'));
    }
    if (hostTest && input.testFilter) {
        if (!/^[A-Za-z0-9_][A-Za-z0-9_:.-]*$/.test(input.testFilter)) {
            throw new Error('testFilter must be a test name filter, not a test-runner option.');
        }
        args.push('--', input.testFilter);
    }
    return args;
}

export interface BuiltArtifact {
    artifactId: string;
    workspace: string;
    executable: string;
    sha256: string;
    kind: CargoInput['kind'];
    name: string;
    packageId: string;
    profile: 'debug' | 'release';
    testHarness: boolean;
}

async function artifactChecksum(file: string) {
    const stat = await fs.stat(file);
    if (!stat.isFile() || !stat.size || stat.size > MAX_ARTIFACT_SIZE) {
        throw new Error('The Cargo executable must be a non-empty file no larger than 128 MiB.');
    }
    return createHash('sha256')
        .update(await fs.readFile(file))
        .digest('hex');
}

export class CargoArtifacts {
    private readonly artifacts = new Map<string, BuiltArtifact>();
    private readonly busy = new Set<string>();

    constructor(private readonly runner: CargoRunner = runCargo) {}

    private async operation<T>(root: string, action: (cwd: string) => Promise<T>) {
        const cwd = await fs.realpath(root);
        if (this.busy.has(cwd)) {
            throw new Error('A Cargo operation is already running in this workspace.');
        }
        this.busy.add(cwd);
        try {
            return await action(cwd);
        } finally {
            this.busy.delete(cwd);
        }
    }

    async inspect(root: string, signal: AbortSignal) {
        return this.operation(root, async (cwd) => {
            const result = await this.runner(
                ['metadata', '--no-deps', '--format-version', '1', '--manifest-path', 'Cargo.toml'],
                cwd,
                signal,
            );
            if (result.exitCode !== 0) {
                throw new Error(`Cargo metadata failed: ${result.stderr}`);
            }
            const metadata: unknown = JSON.parse(result.stdout);
            if (!isRecord(metadata) || !Array.isArray(metadata.packages)) {
                throw new Error('Cargo returned invalid metadata.');
            }
            const version = await this.runner(['-vV'], cwd, signal);
            const hostTriple = /^host: (.+)$/m.exec(version.stdout)?.[1];
            if (version.exitCode !== 0 || !hostTriple) {
                throw new Error(`Could not determine the Cargo host target: ${version.stderr}`);
            }
            return {
                packages: metadata.packages,
                workspaceRoot: metadata.workspace_root,
                hostTriple,
            };
        });
    }

    async build(root: string, input: CargoInput, signal: AbortSignal) {
        const args = cargoArguments(input);
        return this.operation(root, async (cwd) => {
            const result = await this.runner(args, cwd, signal);
            const candidates: Array<Record<string, unknown>> = [];
            const diagnostics: unknown[] = [];
            for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
                const message: unknown = JSON.parse(line);
                if (!isRecord(message)) {
                    throw new Error('Cargo returned an invalid JSON message.');
                }
                if (message.reason === 'compiler-message') {
                    diagnostics.push(message.message);
                }
                if (
                    message.reason === 'compiler-artifact' &&
                    typeof message.executable === 'string' &&
                    isRecord(message.target) &&
                    Array.isArray(message.target.kind) &&
                    message.target.kind.includes(input.kind) &&
                    (input.kind === 'lib' || message.target.name === input.name)
                ) {
                    candidates.push(message);
                }
            }
            if (result.exitCode !== 0) {
                return {
                    success: false,
                    exitCode: result.exitCode,
                    diagnostics,
                    stderr: result.stderr,
                };
            }
            const unique = [...new Map(candidates.map((item) => [item.executable, item])).values()];
            if (unique.length !== 1) {
                throw new Error(
                    `Expected one executable for the selected Cargo target; found ${unique.length}. Specify package and name explicitly.`,
                );
            }
            const candidate = unique[0];
            if (
                !isRecord(candidate.target) ||
                typeof candidate.target.name !== 'string' ||
                typeof candidate.package_id !== 'string' ||
                typeof candidate.executable !== 'string'
            ) {
                throw new Error('Cargo artifact metadata is incomplete.');
            }
            const executable = await fs.realpath(candidate.executable);
            const artifact: BuiltArtifact = {
                artifactId: randomUUID(),
                workspace: cwd,
                executable,
                sha256: await artifactChecksum(executable),
                kind: input.kind,
                name: candidate.target.name,
                packageId: candidate.package_id,
                profile: input.profile ?? 'debug',
                testHarness: isRecord(candidate.profile) && candidate.profile.test === true,
            };
            if (this.artifacts.size >= 64) {
                const oldest = this.artifacts.keys().next().value;
                if (oldest) {
                    this.artifacts.delete(oldest);
                }
            }
            this.artifacts.set(artifact.artifactId, artifact);
            return {success: true, artifact, diagnostics};
        });
    }

    async get(root: string, artifactId: string) {
        const artifact = this.artifacts.get(artifactId);
        if (!artifact || artifact.workspace !== (await fs.realpath(root))) {
            throw new Error('Unknown artifactId for this workspace. Build the target again.');
        }
        if (artifact.sha256 !== (await artifactChecksum(artifact.executable))) {
            throw new Error('The artifact changed since it was built. Build the target again.');
        }
        const file = await fs.open(artifact.executable, 'r');
        try {
            const magic = Buffer.alloc(4);
            await file.read(magic, 0, 4, 0);
            if (!magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
                throw new Error(
                    'The selected executable is not an ELF. Build for the embedded target.',
                );
            }
        } finally {
            await file.close();
        }
        return artifact;
    }

    async test(root: string, input: CargoInput, signal: AbortSignal) {
        if (!input.targetTriple) {
            throw new Error(
                'Host tests require an explicit host targetTriple to override Cargo defaults.',
            );
        }
        const args = cargoArguments(input, true);
        return this.operation(root, async (cwd) => {
            const host = await this.runner(['-vV'], cwd, signal);
            const triple = /^host: (.+)$/m.exec(host.stdout)?.[1];
            if (host.exitCode !== 0 || !triple) {
                throw new Error(`Could not determine the Cargo host target: ${host.stderr}`);
            }
            if (input.targetTriple !== triple) {
                throw new Error(
                    `Host tests require targetTriple "${triple}", not "${input.targetTriple}".`,
                );
            }
            const result = await this.runner(args, cwd, signal);
            return {success: result.exitCode === 0, ...result};
        });
    }
}
