import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { z } from 'zod';
import { EMPTY_MANIFEST, ProjectManifestSchema, type ProjectManifest } from '../shared/manifest.ts';

export function loadProject(root: string, env: NodeJS.ProcessEnv = process.env): { directory: string; filename: string | null; manifest: ProjectManifest } {
  const directory = resolve(root, env.ESPEMU_PROJECT ?? (env.ESPEMU_MANIFEST ? dirname(resolve(root, env.ESPEMU_MANIFEST)) : env.ESPEMU_FLASH ? dirname(dirname(resolve(root, env.ESPEMU_FLASH))) : '.'));
  const filename = env.ESPEMU_MANIFEST ? resolve(root, env.ESPEMU_MANIFEST) : resolve(directory, 'espemu.json');
  if (!existsSync(filename)) {
    if (env.ESPEMU_MANIFEST) throw new Error(`Project manifest not found: ${filename}`);
    return { directory, filename: null, manifest: structuredClone(EMPTY_MANIFEST) };
  }
  try {
    if (statSync(filename).size > 1024 * 1024) throw new Error('Manifest exceeds 1MiB');
    return { directory, filename, manifest: ProjectManifestSchema.parse(JSON.parse(readFileSync(filename, 'utf8'))) };
  } catch (error) {
    const detail = error instanceof z.ZodError ? error.issues.map(issue => `${issue.path.join('.') || 'manifest'}: ${issue.message}`).join('; ') : error instanceof Error ? error.message : 'Invalid JSON';
    throw new Error(`Invalid project manifest ${filename}: ${detail}`);
  }
}
