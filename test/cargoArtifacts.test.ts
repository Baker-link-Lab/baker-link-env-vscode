import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {tmpdir} from 'node:os';
import {test} from 'node:test';
import {
    CargoArtifacts,
    cargoArguments,
    type BuiltArtifact,
    type CargoRunner,
    runCargo,
} from '../src/cargoArtifacts';
import {artifactDebugConfiguration} from '../src/artifactDebug';
import {DEBUG_TYPE} from '../src/bakerLinkIntegration';

test('Cargo arguments preserve target defaults and safely select examples and tests', () => {
    assert.deepEqual(
        cargoArguments({
            kind: 'example',
            name: 'adc_audio',
            package: 'firmware',
            features: ['embassy', 'dep/feature'],
            noDefaultFeatures: true,
        }),
        [
            'build',
            '--message-format=json',
            '--manifest-path',
            'Cargo.toml',
            '--package',
            'firmware',
            '--example',
            'adc_audio',
            '--features',
            'embassy,dep/feature',
            '--no-default-features',
        ],
    );
    assert.deepEqual(
        cargoArguments({
            kind: 'test',
            name: 'adc',
            profile: 'release',
            targetTriple: 'thumbv6m-none-eabi',
        }),
        [
            'test',
            '--no-run',
            '--message-format=json',
            '--manifest-path',
            'Cargo.toml',
            '--test',
            'adc',
            '--release',
            '--target',
            'thumbv6m-none-eabi',
        ],
    );
    assert.equal(cargoArguments({kind: 'lib'})[0], 'test');
    assert.throws(() => cargoArguments({kind: 'bin'}), /Specify name/);
    assert.throws(() => cargoArguments({kind: 'example', name: '--all-targets'}), /identifier/);
    assert.throws(
        () => cargoArguments({kind: 'lib', features: ['feature --all']}),
        /feature names/,
    );
    assert.throws(
        () => cargoArguments({kind: 'lib', targetTriple: '../target.json'}),
        /identifier/,
    );
    assert.throws(
        () => cargoArguments({kind: 'lib', testFilter: '--ignored'}, true),
        /test name filter/,
    );
});

test('Cargo rejects pre-cancelled operations before spawning a process', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(runCargo(['metadata'], tmpdir(), controller.signal), /abort/i);
});

test('Cargo rejects overlapping workspace operations and releases the lock after failure', async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
        markStarted = resolve;
    });
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => {
        finish = resolve;
    });
    const cargo = new CargoArtifacts(async () => {
        markStarted();
        await wait;
        return {exitCode: 1, stdout: '', stderr: 'intentional failure'};
    });
    const signal = new AbortController().signal;
    const first = cargo.build(tmpdir(), {kind: 'lib'}, signal);
    await started;
    await assert.rejects(cargo.inspect(tmpdir(), signal), /already running/);
    finish();
    assert.equal((await first).success, false);
    assert.equal((await cargo.build(tmpdir(), {kind: 'lib'}, signal)).success, false);
});

test('Cargo artifacts use JSON executables, guard workspace and detect changed ELF files', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'baker-cargo-'));
    const executable = path.join(root, 'custom-output.elf');
    const body = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1]);
    await fs.writeFile(executable, body);
    const runner: CargoRunner = async (args, cwd) => {
        assert.equal(cwd, await fs.realpath(root));
        assert.ok(args.includes('--example'));
        return {
            exitCode: 0,
            stderr: '',
            stdout:
                JSON.stringify({
                    reason: 'compiler-artifact',
                    executable,
                    package_id: 'firmware',
                    target: {name: 'adc', kind: ['example']},
                    profile: {test: false},
                }) + '\n',
        };
    };
    try {
        const cargo = new CargoArtifacts(runner);
        const result = await cargo.build(
            root,
            {kind: 'example', name: 'adc'},
            new AbortController().signal,
        );
        assert.equal(result.success, true);
        assert.ok(result.artifact);
        const artifact = await cargo.get(root, result.artifact.artifactId);
        assert.equal(artifact.executable, await fs.realpath(executable));
        await assert.rejects(cargo.get(tmpdir(), artifact.artifactId), /Unknown artifactId/);
        await fs.writeFile(executable, Buffer.concat([body, Buffer.from([2])]));
        await assert.rejects(cargo.get(root, artifact.artifactId), /changed since/);
    } finally {
        await fs.rm(root, {recursive: true, force: true});
    }
});

test('Cargo reports compiler failures and refuses missing or ambiguous artifacts', async () => {
    const signal = new AbortController().signal;
    const failure = new CargoArtifacts(async () => ({
        exitCode: 1,
        stderr: 'compile failed',
        stdout: JSON.stringify({
            reason: 'compiler-message',
            message: {level: 'error', message: 'bad code'},
        }),
    }));
    assert.deepEqual(await failure.build(tmpdir(), {kind: 'lib'}, signal), {
        success: false,
        exitCode: 1,
        diagnostics: [{level: 'error', message: 'bad code'}],
        stderr: 'compile failed',
    });
    const missing = new CargoArtifacts(async () => ({exitCode: 0, stderr: '', stdout: ''}));
    await assert.rejects(missing.build(tmpdir(), {kind: 'lib'}, signal), /found 0/);
    const ambiguous = new CargoArtifacts(async () => ({
        exitCode: 0,
        stderr: '',
        stdout: ['a', 'b']
            .map((executable) =>
                JSON.stringify({
                    reason: 'compiler-artifact',
                    executable,
                    target: {kind: ['lib']},
                }),
            )
            .join('\n'),
    }));
    await assert.rejects(ambiguous.build(tmpdir(), {kind: 'lib'}, signal), /found 2/);
    const malformed = new CargoArtifacts(async () => ({
        exitCode: 0,
        stderr: '',
        stdout: 'not-json',
    }));
    await assert.rejects(malformed.build(tmpdir(), {kind: 'lib'}, signal), SyntaxError);
});

test('Host tests require the exact host triple and report failed tests explicitly', async () => {
    const calls: string[][] = [];
    const cargo = new CargoArtifacts(async (args) => {
        calls.push(args);
        return args[0] === '-vV'
            ? {exitCode: 0, stdout: 'cargo version\nhost: x86_64-pc-windows-msvc\n', stderr: ''}
            : {exitCode: 101, stdout: 'one test failed', stderr: ''};
    });
    const signal = new AbortController().signal;
    await assert.rejects(cargo.test(tmpdir(), {kind: 'lib'}, signal), /explicit host/);
    await assert.rejects(
        cargo.test(tmpdir(), {kind: 'lib', targetTriple: 'thumbv6m-none-eabi'}, signal),
        /require targetTriple/,
    );
    const result = await cargo.test(
        tmpdir(),
        {
            kind: 'lib',
            targetTriple: 'x86_64-pc-windows-msvc',
            testFilter: 'adc',
        },
        signal,
    );
    assert.equal(result.success, false);
    assert.deepEqual(calls.at(-1), [
        'test',
        '--manifest-path',
        'Cargo.toml',
        '--lib',
        '--target',
        'x86_64-pc-windows-msvc',
        '--',
        'adc',
    ]);
});

test('Artifact debug cloning preserves hardware settings and skips only the build task', () => {
    const artifact: BuiltArtifact = {
        artifactId: 'test-123',
        workspace: '/project',
        executable: '/project/example.elf',
        sha256: '',
        kind: 'example',
        name: 'adc',
        packageId: 'project',
        profile: 'debug',
        testHarness: false,
    };
    const base = {
        name: 'Normal',
        type: DEBUG_TYPE,
        request: 'launch',
        chip: 'RP2040',
        speed: 4000,
        preLaunchTask: 'cargo: build',
        bakerLink: {dapServer: 'host:50001', uploadUrl: 'http://host:50002', elf: 'normal.elf'},
        coreConfigs: [{coreIndex: 0, programBinary: 'bakerlink://normal/debug', rttEnabled: true}],
        flashingConfig: {flashingEnabled: false},
        postDebugTask: 'cleanup',
    };
    const copy = artifactDebugConfiguration({mode: 'launchWithArtifact'}, artifact, base);
    assert.equal(base.preLaunchTask, 'cargo: build');
    assert.equal(base.bakerLink.elf, 'normal.elf');
    assert.equal(copy.preLaunchTask, undefined);
    assert.equal(copy.bakerLink.elf, artifact.executable);
    assert.equal(copy.chip, base.chip);
    assert.equal(copy.speed, base.speed);
    assert.deepEqual(copy.flashingConfig, base.flashingConfig);
    assert.equal(copy.postDebugTask, 'cleanup');
    assert.equal(copy.coreConfigs[0].programBinary, 'bakerlink://agent_test123/debug');
    assert.throws(
        () =>
            artifactDebugConfiguration({mode: 'launchWithArtifact'}, artifact, {
                ...base,
                coreConfigs: [base.coreConfigs[0], base.coreConfigs[0]],
            }),
        /exactly one core/,
    );
    assert.throws(
        () =>
            artifactDebugConfiguration({mode: 'launchWithArtifact', chip: 'other'}, artifact, base),
        /inherits hardware/,
    );
    const platform =
        process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
    const platformCopy = artifactDebugConfiguration({mode: 'launchWithArtifact'}, artifact, {
        ...base,
        [platform]: {preLaunchTask: 'wrong build', chip: 'overridden'},
    });
    assert.equal(platformCopy.preLaunchTask, undefined);
    assert.equal(platformCopy.chip, 'overridden');
    assert.equal(platformCopy[platform], undefined);
});

test('Direct launch requires explicit hardware endpoints and supports test ELF without claiming pass/fail', () => {
    const artifact: BuiltArtifact = {
        artifactId: 'abc',
        workspace: '/project',
        executable: '/project/test.elf',
        sha256: '',
        kind: 'test',
        name: 'adc',
        packageId: 'project',
        profile: 'release',
        testHarness: true,
    };
    assert.throws(() => artifactDebugConfiguration({mode: 'direct'}, artifact), /requires chip/);
    assert.throws(
        () =>
            artifactDebugConfiguration(
                {
                    mode: 'direct',
                    chip: 'RP2040',
                    dapServer: 'bad',
                    uploadUrl: 'http://host',
                },
                artifact,
            ),
        /dapServer/,
    );
    const config = artifactDebugConfiguration(
        {
            mode: 'direct',
            chip: 'RP2040',
            dapServer: 'host:50001',
            uploadUrl: 'http://host:50002',
            flash: false,
            rttEnabled: false,
        },
        artifact,
    );
    assert.equal(config.preLaunchTask, undefined);
    assert.equal(config.flashingConfig.flashingEnabled, false);
    assert.equal(config.coreConfigs[0].rttEnabled, false);
    assert.equal(config.coreConfigs[0].programBinary, 'bakerlink://agent_abc/release');
});
