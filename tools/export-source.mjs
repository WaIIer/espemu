import { chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir, hostname } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = process.argv[2] && resolve(process.argv[2]);
const sources = [
    '.gitignore', '.gitattributes', '.dockerignore', '.github/workflows/ci.yml', 'Dockerfile', 'compose.yml', 'README.md',
    'package.json', 'package-lock.json', 'tsconfig.json', 'versions.env',
    'playwright.config.ts', 'playwright.project.config.ts', 'playwright.soak.config.ts',
    'frontend', 'server', 'shared', 'tools', 'docs', 'templates', 'tests', 'e2e', 'soak',
    'qemu/espemu.patch', 'components/espemu_devices',
    'firmware/CMakeLists.txt', 'firmware/sdkconfig.defaults', 'firmware/espemu.json', 'firmware/main', 'firmware/components/bme280',
];
const excludedDirectories = new Set(['.git', '.cache', '.run', '.vscode', 'node_modules', 'dist', 'build', 'managed_components', '__pycache__', 'test-results', 'playwright-report']);
const excludedFiles = new Set(['sdkconfig', 'sdkconfig.old', 'dependencies.lock', 'compile_commands.json', '.DS_Store']);
const privateProjects = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && !sources.some(path => path === entry.name || path.startsWith(entry.name + '/')) && !excludedDirectories.has(entry.name) && existsSync(join(root, entry.name, 'CMakeLists.txt'))).map(entry => entry.name);
const privateValues = [root, homedir(), ...(hostname().length >= 5 ? [hostname()] : [])];
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const privateNames = privateProjects.map(name => new RegExp(`(?<![A-Za-z0-9_-])${escape(name)}(?![A-Za-z0-9_-])`));
const rules = [
    ['absolute user path', /(?:\/home\/|\/Users\/|[A-Za-z]:\\Users\\)[A-Za-z0-9_.-]+/],
    ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
    ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
    ['credential URL', /https?:\/\/[^\s/@:]+:[^\s/@]+@/],
    ['cloud access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
];

function ignored(path, name) {
    return path.split('/').some(part => excludedDirectories.has(part)) || excludedFiles.has(name) || name.startsWith('.espemu-') || name === '.env' || name.startsWith('.env.') || /\.(?:log|pyc|o|a|so|elf|bin|map|pem|p12|pfx|key)$/.test(name);
}

function filesUnder(path) {
    const filename = join(root, path), info = lstatSync(filename), name = path.split('/').at(-1);
    if (ignored(path, name)) return [];
    if (info.isSymbolicLink()) throw new Error(`Refusing source symlink: ${path}`);
    if (info.isDirectory()) {
        if (existsSync(join(filename, '.espemu-project'))) throw new Error(`User project found inside source selection: ${path}`);
        return readdirSync(filename).sort().flatMap(child => filesUnder(`${path}/${child}`));
    }
    if (!info.isFile()) throw new Error(`Unexpected non-file source: ${path}`);
    return [{ path, mode: info.mode & 0o777, bytes: readFileSync(filename) }];
}

try {
    if (!destination) throw new Error('Usage: node tools/export-source.mjs NEW_DESTINATION');
    const difference = relative(root, destination);
    if (!difference || sources.some(path => difference === path || difference.startsWith(path + sep))) throw new Error('Choose a separate export directory, not selected source files.');
    if (existsSync(destination)) throw new Error('Export destination must not exist; existing files are never overwritten.');
    const files = sources.flatMap(filesUnder), failures = [];
    for (const file of files) {
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes); } catch { failures.push(`${file.path}: unexpected binary source`); continue; }
        if (text.includes('\0')) { failures.push(`${file.path}: unexpected binary source`); continue; }
        if (privateValues.some(value => value && text.includes(value))) failures.push(`${file.path}: local machine identity/path`);
        if (privateNames.some(pattern => pattern.test(text))) failures.push(`${file.path}: private project name`);
        for (const [name, pattern] of rules) if (pattern.test(text)) failures.push(`${file.path}: ${name}`);
        if (isAbsolute(file.path) || file.path.split('/').includes('..')) failures.push(`${file.path}: unsafe export path`);
    }
    if (failures.length) throw new Error(`Source audit failed; nothing exported:\n${failures.join('\n')}`);
    mkdirSync(destination, { recursive: true });
    for (const file of files) {
        const target = join(destination, file.path); mkdirSync(dirname(target), { recursive: true });
        copyFileSync(join(root, file.path), target, constants.COPYFILE_EXCL); chmodSync(target, file.mode);
    }
    console.log(JSON.stringify({ directory: destination, files: files.length, bytes: files.reduce((total, file) => total + file.bytes.length, 0), privacyAudit: 'passed', topLevel: [...new Set(files.map(file => file.path.split('/')[0]))].sort() }, null, 2));
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
