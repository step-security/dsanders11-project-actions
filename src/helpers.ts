import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as tc from '@actions/tool-cache';

import { Octokit } from '@octokit/core';
import { paginateGraphQL } from '@octokit/plugin-paginate-graphql';

const GH_CLI_RELEASES = 'https://github.com/cli/cli/releases/';
const GH_VERSION = '2.103.3';
const GH_DEB_FILENAME = `gh_${GH_VERSION}_linux_amd64.tar.gz`;
const GH_CHECKSUMS_FILENAME = `gh_${GH_VERSION}_checksums.txt`;

async function fetchExpectedChecksum(): Promise<string | null> {
  try {
    const checksumsPath = await tc.downloadTool(
      `${GH_CLI_RELEASES}/download/v${GH_VERSION}/${GH_CHECKSUMS_FILENAME}`
    );
    const contents = fs.readFileSync(checksumsPath, 'utf8');
    const line = contents.split('\n').find(l => l.endsWith(GH_DEB_FILENAME));
    if (!line) {
      core.warning(
        `Checksum entry not found for ${GH_DEB_FILENAME} — skipping verification`
      );
      return null;
    }
    return line.split(/\s+/)[0];
  } catch {
    core.warning(
      `Failed to fetch checksums file for gh v${GH_VERSION} — skipping verification`
    );
    return null;
  }
}

export async function installGhCli(): Promise<string> {
  if (process.platform !== 'linux') {
    throw new Error('Only Linux runners have support at the moment');
  }

  let toolPath = tc.find('gh', GH_VERSION);

  // Download and cache if not already cached
  if (!toolPath) {
    const [downloadPath, expectedChecksum] = await Promise.all([
      tc.downloadTool(
        `${GH_CLI_RELEASES}/download/v${GH_VERSION}/${GH_DEB_FILENAME}`
      ),
      fetchExpectedChecksum()
    ]);
    if (expectedChecksum) {
      const hash = crypto
        .createHash('sha256')
        .update(fs.readFileSync(downloadPath))
        .digest('hex');
      if (hash !== expectedChecksum) {
        core.warning(
          `Checksum mismatch for ${GH_DEB_FILENAME}: expected ${expectedChecksum}, got ${hash}`
        );
      }
    }
    const extractedPath = await tc.extractTar(downloadPath, undefined, [
      'xz',
      '--strip',
      '1'
    ]);
    toolPath = await tc.cacheDir(extractedPath, 'gh', GH_VERSION);
  }

  return path.join(toolPath, 'bin', 'gh');
}

export async function execCliCommand(args: string[]): Promise<string> {
  const token = core.getInput('token', { required: true });
  const gh = await installGhCli();

  const env: Record<string, string> = { GH_TOKEN: token };

  if (core.isDebug()) {
    env.GH_DEBUG = 'api';
  }

  const { exitCode, stdout, stderr } = await exec.getExecOutput(gh, args, {
    env,
    ignoreReturnCode: true,
    silent: !core.isDebug()
  });

  // The gh CLI does not always set the exit code properly on failure, so
  // check for these silent failures by looking for stderr with no stdout
  if (exitCode !== 0 || (!stdout && stderr)) {
    throw new Error(stderr);
  }

  return stdout;
}

export function getOctokit(): Octokit & ReturnType<typeof paginateGraphQL> {
  const token = core.getInput('token', { required: true });

  const PaginatedOctokit = Octokit.plugin(paginateGraphQL);

  return new PaginatedOctokit({ auth: token });
}
