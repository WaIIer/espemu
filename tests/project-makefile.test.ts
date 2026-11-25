import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, chmodSync, symlinkSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
function create(directory: string) {
  const result = spawnSync('bash', [join(root, 'tools/setup-project.sh'), directory, '--init-only'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
test('new projects include a discoverable Makefile and recorded framework path', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'espemu-make-'));
  try {
    const directory = join(temporary, 'project with spaces');
    create(directory);
    assert.equal(readFileSync(join(directory, '.espemu-framework'), 'utf8').trim(), root);
    const result = spawnSync('make', ['-C', directory, 'help'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    for (const target of ['build','run','web','clean','rebuild','configure','validate','tools','add_component','doctor']) assert.ok(result.stdout.includes(`make ${target}`));
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
test('Makefile forwards each command and the exact project directory, including spaces', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'espemu-make-'));
  try {
    const directory = join(temporary, 'project with spaces');
    create(directory);
    const framework = join(temporary, 'framework with spaces');
    mkdirSync(join(framework, 'tools'), { recursive: true });
    writeFileSync(join(framework, 'tools/project-command.sh'), '#!/usr/bin/env bash\nprintf "COMMAND=%s\\nPROJECT=%s\\n" "$1" "$2"\n');
    writeFileSync(join(directory, '.espemu-framework'), framework + '\n');
    for (const command of ['build','run','web','clean','rebuild','configure','validate','tools','add_component','doctor']) {
      const result = spawnSync('make', ['-C', directory, command], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes(`COMMAND=${command}`));
      assert.ok(result.stdout.includes(`PROJECT=${directory}`));
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
test('make clean removes build output and preserves firmware, config and manifest', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'espemu-make-'));
  try {
    create(temporary);
    mkdirSync(join(temporary, 'build')); writeFileSync(join(temporary, 'build/output.bin'), 'generated');
    writeFileSync(join(temporary, 'sdkconfig'), 'user configuration');
    const source = readFileSync(join(temporary, 'main/main.c'), 'utf8');
    const manifest = readFileSync(join(temporary, 'espemu.json'), 'utf8');
    const result = spawnSync('make', ['-C', temporary, 'clean'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(temporary, 'build')), false);
    assert.equal(readFileSync(join(temporary, 'main/main.c'), 'utf8'), source);
    assert.equal(readFileSync(join(temporary, 'espemu.json'), 'utf8'), manifest);
    assert.equal(readFileSync(join(temporary, 'sdkconfig'), 'utf8'), 'user configuration');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('Makefile can be added to an existing project without changing source, manifest or user Makefile', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'espemu-make-'));
  try {
    create(temporary);
    rmSync(join(temporary, 'Makefile')); rmSync(join(temporary, '.espemu-framework'));
    writeFileSync(join(temporary, 'main/main.c'), 'user application\n');
    const manifest = readFileSync(join(temporary, 'espemu.json'), 'utf8');
    const install = spawnSync('bash', [join(root, 'tools/setup-project.sh'), temporary, '--makefile-only'], { encoding: 'utf8' });
    assert.equal(install.status, 0, install.stderr);
    assert.ok(existsSync(join(temporary, 'Makefile')));
    assert.equal(readFileSync(join(temporary, 'main/main.c'), 'utf8'), 'user application\n');
    assert.equal(readFileSync(join(temporary, 'espemu.json'), 'utf8'), manifest);
    writeFileSync(join(temporary, 'Makefile'), 'user-owned Makefile\n');
    assert.equal(spawnSync('bash', [join(root, 'tools/setup-project.sh'), temporary, '--makefile-only']).status, 0);
    assert.equal(readFileSync(join(temporary, 'Makefile'), 'utf8'), 'user-owned Makefile\n');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('only untouched older framework Makefiles receive new project commands',()=>{
  const directory=mkdtempSync(join(tmpdir(),'espemu-old-make-'));
  try{
    create(directory);
    const template=readFileSync(join(root,'templates/project.Makefile'),'utf8');
    const previous=template.split('\n').filter(line=>!line.includes('make test ')&&!line.includes('DEVICE=TYPE')).join('\n').replaceAll(' add_component doctor test',' add_component doctor');
    assert.notEqual(previous,template);
    for(const removed of [[], ['doctor'], ['add_component','doctor'], ['docs','editor','add_component','doctor']]){
      const legacy=removed.length?previous.split('\n').filter(line=>!removed.some(command=>line.includes(`make ${command} `))).join('\n').replaceAll(` ${removed.join(' ')}`,''):previous;
      writeFileSync(join(directory,'Makefile'),legacy.trimEnd());
      const source=readFileSync(join(directory,'main/main.c'),'utf8'),manifest=readFileSync(join(directory,'espemu.json'),'utf8');
      const result=spawnSync('bash',[join(root,'tools/setup-project.sh'),directory,'--makefile-only'],{encoding:'utf8'});
      assert.equal(result.status,0,result.stderr);assert.equal(readFileSync(join(directory,'Makefile'),'utf8'),template);
      assert.equal(readFileSync(join(directory,'main/main.c'),'utf8'),source);assert.equal(readFileSync(join(directory,'espemu.json'),'utf8'),manifest);
    }
    const edited=template+'\ncustom_target:\n\t@true\n';writeFileSync(join(directory,'Makefile'),edited);
    assert.equal(spawnSync('bash',[join(root,'tools/setup-project.sh'),directory,'--makefile-only']).status,0);
    assert.equal(readFileSync(join(directory,'Makefile'),'utf8'),edited);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('make validate uses the current project and make web explains a missing firmware build', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'espemu-make-'));
  try {
    create(temporary);
    const validate = spawnSync('make', ['-C', temporary, 'validate'], { encoding: 'utf8' });
    assert.equal(validate.status, 0, validate.stderr); assert.match(validate.stdout, /Valid esp32 circuit: 0 peripheral/);
    const web = spawnSync('make', ['-C', temporary, 'web'], { encoding: 'utf8' });
    assert.notEqual(web.status, 0); assert.match(web.stderr, /Run make build or make run first/);
    assert.equal(existsSync(join(temporary, 'build')), false);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('make add_component adds one device and returns without building or running', {timeout:15000},async()=>{
  const directory=mkdtempSync(join(tmpdir(),'espemu add component '));
  create(directory);
  const source=readFileSync(join(directory,'main/main.c'),'utf8');
  const child=spawn('make',['--no-print-directory','-C',directory,'add_component'],{stdio:['pipe','pipe','pipe']});
  let output='',errors='',step=0;
  const prompts=['? Peripheral type','? Instance id','? GPIO pin','? Active low?','? Add component?'],answers=['8','','','','y'];
  try{
    const status=await new Promise<number|null>((done,reject)=>{
      const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error(`Component wizard did not exit: ${output}\n${errors}`));},10000);
      child.stdout.on('data',chunk=>{output+=chunk;while(step<prompts.length&&output.includes(prompts[step]))child.stdin.write(answers[step++]+'\n');});
      child.stderr.on('data',chunk=>{errors+=chunk;});
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('close',code=>{clearTimeout(timer);done(code);});
    });
    assert.equal(status,0,errors);assert.equal(step,prompts.length);
    const manifest=JSON.parse(readFileSync(join(directory,'espemu.json'),'utf8'));
    assert.equal(manifest.devices.length,1);assert.equal(manifest.devices[0].type,'switch');assert.equal(manifest.devices[0].pin,27);
    assert.equal(readFileSync(join(directory,'main/main.c'),'utf8'),source);assert.equal(existsSync(join(directory,'build')),false);
    assert.doesNotMatch(output,/Project directory|Language|Starter|ESPEmu control backend|QEMU emulator version/);
  }finally{child.stdin.destroy();child.kill('SIGTERM');rmSync(directory,{recursive:true,force:true});}
});

test('native firmware builds cap compilation jobs and reject invalid overrides', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'espemu-build-jobs-'));
  try {
    const sdk = join(temporary, 'sdk');
    const project = join(temporary, 'project');
    mkdirSync(join(sdk, 'bin'), { recursive: true });
    mkdirSync(join(project, 'build'), { recursive: true });
    writeFileSync(join(project, 'CMakeLists.txt'), 'project(fixture)\n');
    writeFileSync(join(sdk, 'export.sh'), 'export PATH="$IDF_PATH/bin:$PATH"\n');
    for (const [command, body] of Object.entries({
      'idf.py': 'printf "idf: %s\\n" "$*"',
      cmake: 'printf "cmake: %s (nested: %s)\\n" "$*" "$CMAKE_BUILD_PARALLEL_LEVEL"',
      'esptool.py': 'while [[ "$1" != -o ]]; do shift; done; printf image > "$2"',
    })) writeFileSync(join(sdk, 'bin', command), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
    const build = (jobs: string) => spawnSync('bash', [join(root, 'tools/build-firmware.sh'), project], {
      encoding: 'utf8', env: { ...process.env, IDF_PATH: sdk, BUILD_JOBS: jobs },
    });
    for (const [setting, expected] of [['', '2'], ['1', '1']]) {
      const result = build(setting);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /^idf: reconfigure$/m);
      assert.ok(result.stdout.includes(`cmake: --build build --parallel ${expected} (nested: ${expected})`), result.stdout);
      assert.equal(readFileSync(join(project, 'build/qemu_flash.bin'), 'utf8'), 'image');
    }
    for (const setting of ['0', 'unlimited']) {
      const result = build(setting);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /BUILD_JOBS must be a positive integer/);
      assert.equal(result.stdout, '');
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('prepared-image wrappers reuse installed tools without bootstrapping workspace caches',()=>{
  const temporary=mkdtempSync(join(tmpdir(),'espemu-preinstalled-'));
  try{
    const framework=join(temporary,'framework'),project=join(temporary,'project');
    for(const folder of ['tools','server','.cache/qemu/build','dist'])mkdirSync(join(framework,folder),{recursive:true});
    mkdirSync(join(framework,'.github/skills/espemu-environment/scripts'),{recursive:true});
    writeFileSync(join(framework,'.github/skills/espemu-environment/scripts/setup.sh'),'#!/usr/bin/env bash\n[[ "$1" == --web ]] || exit 92\nexit 93\n');
    mkdirSync(join(project,'build'),{recursive:true});
    for(const name of ['env.sh','project-command.sh','create-project.sh','generate-project-artifacts.sh','demo.sh'])copyFileSync(join(root,'tools',name),join(framework,'tools',name));
    copyFileSync(join(root,'versions.env'),join(framework,'versions.env'));
    writeFileSync(join(framework,'package.json'),'{"type":"module"}\n');
    symlinkSync(join(root,'node_modules'),join(framework,'node_modules'));
    writeFileSync(join(framework,'tools/bootstrap.sh'),'#!/usr/bin/env bash\nprintf "UNEXPECTED_BOOTSTRAP\\n" >&2\nexit 91\n');
    writeFileSync(join(framework,'tools/build-firmware.sh'),'#!/usr/bin/env bash\nprintf "NATIVE_BUILD_REUSED\\n"\n');
    writeFileSync(join(framework,'tools/project-creator.ts'),'console.log("CREATOR_REUSED");\n');
    writeFileSync(join(framework,'tools/project-artifacts.ts'),'console.log("ARTIFACTS_REUSED");\n');
    writeFileSync(join(framework,'server/project.ts'),`export { loadProject } from ${JSON.stringify(join(root,'server/project.ts'))};\n`);
    writeFileSync(join(framework,'server/index.ts'),'console.log("WEB_REUSED");\n');
    writeFileSync(join(framework,'dist/index.html'),'<html></html>');
    const qemu=join(framework,'.cache/qemu/build/qemu-system-xtensa');writeFileSync(qemu,'#!/usr/bin/env bash\nexit 0\n');chmodSync(qemu,0o755);
    // A prepared image has ESP-IDF installed; do not depend on the host having one.
    const idf=join(temporary,'esp-idf'),idfTools=join(temporary,'idf-tools');
    for(const folder of [idf,join(idfTools,'python_env'),join(idfTools,'tools/xtensa-esp-elf')])mkdirSync(folder,{recursive:true});
    writeFileSync(join(idf,'export.sh'),'');writeFileSync(join(idf,'.espemu-idf-commit'),readFileSync(join(root,'versions.env'),'utf8').match(/^IDF_COMMIT=(.*)$/m)![1]);
    const env={...process.env,IDF_PATH:idf,IDF_TOOLS_PATH:idfTools};
    writeFileSync(join(project,'CMakeLists.txt'),'project(prepared)');writeFileSync(join(project,'espemu.json'),' {"v":1,"target":"esp32"}');writeFileSync(join(project,'build/qemu_flash.bin'),'fixture');
    for(const [script,args,expected]of [
      ['create-project.sh',[],/CREATOR_REUSED/],
      ['generate-project-artifacts.sh',[project],/ARTIFACTS_REUSED/],
      ['project-command.sh',['validate',project],/Valid esp32 circuit/],
      ['project-command.sh',['build',project],/NATIVE_BUILD_REUSED/],
      ['demo.sh',[project,'--no-build'],/WEB_REUSED/],
    ] as const){
      const result=spawnSync('bash',[join(framework,'tools',script),...args],{encoding:'utf8',env,timeout:10000});
      assert.equal(result.status,0,`${script}: ${result.stderr}`);assert.match(result.stdout,expected);assert.doesNotMatch(result.stderr,/UNEXPECTED_BOOTSTRAP/);
    }
    assert.equal(existsSync(join(framework,'.cache/node')),false);
    writeFileSync(join(framework,'tools/artifact-provenance.sh'),'#!/usr/bin/env bash\nif [[ "$2" == qemu ]]; then printf "Stale qemu inputs\\n"; exit 3; fi\n');
    const stale=spawnSync('bash',[join(framework,'tools/demo.sh'),project,'--no-build'],{encoding:'utf8',env:process.env});
    assert.equal(stale.status,3);assert.match(stale.stdout,/Stale qemu inputs/);assert.doesNotMatch(stale.stdout,/WEB_REUSED/);
    const versions=readFileSync(join(framework,'versions.env'),'utf8');writeFileSync(join(framework,'versions.env'),versions.replace(/NODE_VERSION=.*/, 'NODE_VERSION=0.0.0'));
    assert.equal(spawnSync('bash',[join(framework,'tools/create-project.sh')],{encoding:'utf8',env:process.env}).status,93,'Incorrect Node must fail through web-only preparation');
  }finally{rmSync(temporary,{recursive:true,force:true});}
});

test('web preparation reuses installed packages by lock contents even after the source lock was touched', () => {
  const directory = mkdtempSync(join(tmpdir(), 'espemu-web-lock-'));
  try {
    for (const folder of ['tools', 'node_modules/tsx/dist']) mkdirSync(join(directory, folder), { recursive: true });
    copyFileSync(join(root, 'tools/env.sh'), join(directory, 'tools/env.sh'));
    copyFileSync(join(root, 'versions.env'), join(directory, 'versions.env'));
    writeFileSync(join(directory, 'node_modules/tsx/dist/loader.mjs'), '');
    const installed = { 'node_modules/tsx': { version: '4.19.4', integrity: 'fixture' } };
    writeFileSync(join(directory, 'node_modules/.package-lock.json'), JSON.stringify({ packages: installed }));
    const source = join(directory, 'package-lock.json');
    const check = () => spawnSync('bash', ['-c', 'source "$1" && espemu_dependencies_match', 'test', join(directory, 'tools/env.sh')]);
    writeFileSync(source, JSON.stringify({ packages: { '': {}, ...installed } }));
    assert.equal(check().status, 0);
    writeFileSync(source, JSON.stringify({ packages: { 'node_modules/tsx': { ...installed['node_modules/tsx'], version: '4.19.5' } } }));
    assert.equal(check().status, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('verification image passes browser dependency installation flags through npm',()=>{
  const directory=mkdtempSync(join(tmpdir(),'espemu-browser-flags-'));
  try{
    assert.match(readFileSync(join(root,'Dockerfile'),'utf8'),/RUN npm exec -- playwright install --with-deps chromium/);
    mkdirSync(join(directory,'node_modules/.bin'),{recursive:true});
    writeFileSync(join(directory,'package.json'),'{"name":"browser-flag-regression","version":"1.0.0"}\n');
    const cli=join(directory,'node_modules/.bin/playwright');
    writeFileSync(cli,'#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n');chmodSync(cli,0o755);
    const result=spawnSync('npm',['exec','--','playwright','install','--with-deps','chromium'],{cwd:directory,encoding:'utf8',env:process.env,timeout:10000});
    assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout.trim()),['install','--with-deps','chromium']);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
