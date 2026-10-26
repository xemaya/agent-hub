import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createToken } from './ids.js';

export async function loadHubCredentials(dataDir, env = process.env) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, 'credentials.json');
  let stored = {};
  try {
    stored = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error(`Cannot load Hub credentials: ${error.message}`);
  }

  const generated = [];
  let adminToken = env.AGENT_HUB_ADMIN_TOKEN ?? stored.adminToken;
  let enrollmentToken = env.AGENT_HUB_ENROLLMENT_TOKEN ?? stored.enrollmentToken;
  if (!adminToken) {
    adminToken = createToken('ah_admin');
    generated.push('adminToken');
  }
  if (!enrollmentToken) {
    enrollmentToken = createToken('ah_enroll');
    generated.push('enrollmentToken');
  }

  if (!env.AGENT_HUB_ADMIN_TOKEN && !env.AGENT_HUB_ENROLLMENT_TOKEN) {
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ adminToken, enrollmentToken }, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, file);
    await chmod(file, 0o600);
  }

  return { adminToken, enrollmentToken, generated, file };
}
