import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

function service(baseUrl) {
  return `com.penguinradar.cli.${createHash('sha256').update(baseUrl).digest('hex').slice(0, 24)}`;
}

function security(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/security', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const output = [];
    child.stdout.on('data', (chunk) => output.push(chunk));
    // Do not surface security diagnostics: interactive commands can include secrets.
    child.stderr.resume();
    child.on('error', () =>
      reject(new Error('System Keychain is unavailable. Use PENGUINRADAR_API_KEY.')),
    );
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(output).toString().trim());
      else {
        const error = new Error('System Keychain operation failed. Use PENGUINRADAR_API_KEY.');
        error.keychainExitCode = code;
        reject(error);
      }
    });
    child.stdin.end(input);
  });
}

export async function readCredential(baseUrl, env = process.env, platform = process.platform) {
  if (env.PENGUINRADAR_API_KEY?.trim()) return env.PENGUINRADAR_API_KEY.trim();
  if (platform !== 'darwin') return null;
  try {
    return await security(['find-generic-password', '-s', service(baseUrl), '-a', 'api-key', '-w']);
  } catch {
    return null;
  }
}

export async function saveCredential(baseUrl, key, platform = process.platform) {
  if (platform !== 'darwin')
    throw new Error(
      'This platform uses PENGUINRADAR_API_KEY from your environment or secret manager. No plaintext credential is saved.',
    );
  if (!key || /[\r\n\0]/.test(key)) throw new Error('Invalid API Key.');
  const quoted = `"${key.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  // Pass the secret through stdin, never through process arguments or a shell.
  await security(
    ['-i'],
    `add-generic-password -U -s ${service(baseUrl)} -a api-key -w ${quoted}\n`,
  );
  const stored = await readCredential(baseUrl, {}, platform);
  if (stored !== key) throw new Error('Could not verify Keychain storage. Use PENGUINRADAR_API_KEY.');
}

export async function removeCredential(baseUrl, platform = process.platform) {
  if (platform !== 'darwin') return;
  try {
    await security(['delete-generic-password', '-s', service(baseUrl), '-a', 'api-key']);
  } catch (error) {
    if (error.keychainExitCode !== 44) throw error;
  }
}
