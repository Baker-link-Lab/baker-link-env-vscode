import * as vscode from 'vscode';
import {isRecord, parseConnection} from './bakerLink';
import {DEBUG_TYPE} from './bakerLinkIntegration';
import type {BuiltArtifact} from './cargoArtifacts';

export interface DebugInput {
    workspaceFolder?: string;
    mode?: 'launch' | 'launchWithArtifact' | 'direct';
    configuration?: string;
    artifactId?: string;
    chip?: string;
    dapServer?: string;
    uploadUrl?: string;
    flash?: boolean;
    haltAfterReset?: boolean;
    rttEnabled?: boolean;
}

export function artifactDebugConfiguration(
    input: DebugInput,
    artifact: BuiltArtifact,
    base?: vscode.DebugConfiguration,
): vscode.DebugConfiguration {
    const direct = input.mode === 'direct';
    if (!direct && (!base || base.type !== DEBUG_TYPE || base.request !== 'launch')) {
        throw new Error('Select an existing Baker Link launch configuration.');
    }
    if (
        direct &&
        (input.configuration || !input.chip?.trim() || !input.dapServer || !input.uploadUrl)
    ) {
        throw new Error(
            'Direct mode requires chip, dapServer, and uploadUrl and no configuration name.',
        );
    }
    if (
        !direct &&
        [
            input.chip,
            input.dapServer,
            input.uploadUrl,
            input.flash,
            input.haltAfterReset,
            input.rttEnabled,
        ].some((value) => value !== undefined)
    ) {
        throw new Error(
            'launchWithArtifact inherits hardware settings; use direct mode to specify them.',
        );
    }
    const config: vscode.DebugConfiguration = direct
        ? {
              type: DEBUG_TYPE,
              request: 'launch',
              name: `Baker Link: ${artifact.name}`,
              chip: input.chip,
              bakerLink: parseConnection({dapServer: input.dapServer, uploadUrl: input.uploadUrl}),
              flashingConfig: {
                  flashingEnabled: input.flash ?? true,
                  haltAfterReset: input.haltAfterReset ?? true,
              },
              coreConfigs: [{coreIndex: 0, rttEnabled: input.rttEnabled ?? true}],
          }
        : structuredClone(base!);
    if (!direct) {
        const platform =
            process.platform === 'win32'
                ? 'windows'
                : process.platform === 'darwin'
                  ? 'osx'
                  : 'linux';
        if (config[platform] !== undefined) {
            if (!isRecord(config[platform])) {
                throw new Error(`Invalid ${platform} launch override.`);
            }
            Object.assign(config, config[platform]);
        }
        delete config.windows;
        delete config.osx;
        delete config.linux;
    }
    if (
        config.remoteServerMode === true ||
        !Array.isArray(config.coreConfigs) ||
        config.coreConfigs.length !== 1 ||
        !isRecord(config.coreConfigs[0])
    ) {
        throw new Error(
            'Artifact substitution requires remoteServerMode false and exactly one core.',
        );
    }
    if (config.bakerLink !== undefined && !isRecord(config.bakerLink)) {
        throw new Error('bakerLink must be an object.');
    }
    delete config.preLaunchTask;
    config.remoteServerMode = false;
    config.bakerLink = {...config.bakerLink, elf: artifact.executable};
    config.coreConfigs[0].programBinary = `bakerlink://agent_${artifact.artifactId.replace(/-/g, '')}/${artifact.profile}`;
    return config;
}
