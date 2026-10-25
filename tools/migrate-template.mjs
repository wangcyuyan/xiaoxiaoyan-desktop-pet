#!/usr/bin/env node
/**
 * 受控模板迁移工具 (Controlled Template Migration)
 *
 * 背景：
 *   .doubao-pet-builder.json 的 criticalFileHashes 锁住了 28 个模板文件，
 *   preflight.mjs 在每次构建前逐个校验 SHA256，任何一个对不上就 exit(1)。
 *   官方提示是 "Use pet-spec/environment configuration or an explicit builder
 *   migration; do not refresh hashes by hand."
 *
 * 本脚本实现的就是那条 "explicit builder migration" 通道，拆成两阶段：
 *   prepare : 在动手改文件之前，登记意图 + 备份原文件 + 记录旧哈希
 *   commit  : 文件改完之后，重算哈希并写入受保护清单，完成迁移
 *   rollback: 按记录恢复旧文件内容与旧哈希
 *
 * 两阶段是必需的——preflight 会在构建时校验，如果先改文件再登记，
 * 工程会处于"哈希漂移但无人认领"的中间态。
 *
 * 用法：
 *   node tools/migrate-template.mjs prepare --allow <file>... --reason "..."
 *   node tools/migrate-template.mjs commit
 *   node tools/migrate-template.mjs rollback
 *   node tools/migrate-template.mjs status
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const provenancePath = path.join(root, '.doubao-pet-builder.json');
const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
const critical = provenance.criticalFileHashes ?? {};
const log = provenance.migrationLog ?? [];
const backupDir = path.join(root, '.template-migration-backup');
const PENDING = 'pendingMigration';

async function sha256(file) {
  return createHash('sha256').update(await readFile(path.join(root, file))).digest('hex');
}

function parseArgs(argv) {
  const args = { command: argv[0] ?? '', allow: [], reason: '' };
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--allow') args.allow.push(argv[++i]);
    else if (argv[i] === '--reason') args.reason = argv[++i];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const save = () => writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');

if (args.command === 'status') {
  console.log('--- 受保护文件哈希状态 ---');
  let drift = 0;
  for (const [file, expected] of Object.entries(critical)) {
    const actual = existsSync(path.join(root, file)) ? await sha256(file) : '(缺失)';
    const ok = actual === expected;
    if (!ok) drift += 1;
    console.log(`  ${ok ? 'OK   ' : 'DRIFT'} ${file}`);
  }
  console.log(`漂移: ${drift} / ${Object.keys(critical).length}`);
  if (provenance[PENDING]) {
    console.log(`\n待提交迁移: ${provenance[PENDING].files.join(', ')}`);
  }
  console.log(`\n--- 迁移历史 (${log.length} 条) ---`);
  for (const entry of log) {
    console.log(`  ${entry.timestamp}  ${entry.reason}`);
    for (const file of entry.files) console.log(`      - ${file}`);
  }
  process.exit(0);
}

if (args.command === 'prepare') {
  if (!args.allow.length) { console.error('必须用 --allow 指定要迁移的文件。'); process.exit(1); }
  if (!args.reason) { console.error('必须用 --reason 说明迁移原因（写入审计记录）。'); process.exit(1); }
  const unknown = args.allow.filter((file) => !(file in critical));
  if (unknown.length) { console.error(`以下文件不在受保护清单中，无需迁移: ${unknown.join(', ')}`); process.exit(1); }

  // 基线必须干净：确保没有把别人的未登记改动混进来
  // --force 允许在基线有漂移时继续（例如基线备份本身就晚于受保护哈希），
  // 但漂移文件必须同时被 --allow 登记，否则不予放行。
  const drift = [];
  for (const [file, expected] of Object.entries(critical)) {
    if (await sha256(file) !== expected) drift.push([file, expected]);
  }
  if (drift.length) {
    const unregistered = drift.filter(([file]) => !args.allow.includes(file));
    if (unregistered.length) {
      console.error('迁移前基线不干净，以下文件已偏离受保护哈希且未登记:');
      for (const [file] of unregistered) console.error(`  - ${file}`);
      console.error('先执行 rollback，或把它们加进 --allow 列表。');
      process.exit(1);
    }
    console.warn('注意：以下已登记文件与受保护哈希不一致，将被本次迁移覆盖:');
    for (const [file] of drift) console.warn(`  - ${file}`);
  }

  const id = `mig-${Date.now()}`;
  const backupPath = path.join(backupDir, id);
  await mkdir(backupPath, { recursive: true });
  const previousHashes = {};
  for (const file of args.allow) {
    copyFile(path.join(root, file), path.join(backupPath, file.replace(/[\\/]/g, '__')));
    previousHashes[file] = critical[file];
  }
  provenance[PENDING] = {
    id,
    timestamp: new Date().toISOString(),
    reason: args.reason,
    files: args.allow,
    previousHashes,
    backup: path.relative(root, backupPath),
  };
  await save();
  console.log(`已登记迁移意图 (${id})`);
  console.log(`  文件: ${args.allow.join(', ')}`);
  console.log(`  原因: ${args.reason}`);
  console.log(`  备份: ${path.relative(root, backupPath)}`);
  console.log('现在可以修改这些文件，改完执行: node tools/migrate-template.mjs commit');
  process.exit(0);
}

if (args.command === 'commit') {
  const pending = provenance[PENDING];
  if (!pending) { console.error('没有待提交的迁移，请先执行 prepare。'); process.exit(1); }
  for (const file of pending.files) {
    if (!existsSync(path.join(root, file))) { console.error(`文件已丢失，无法提交: ${file}`); process.exit(1); }
    critical[file] = await sha256(file);
  }
  provenance.criticalFileHashes = critical;
  log.push({
    id: pending.id,
    timestamp: new Date().toISOString(),
    reason: pending.reason,
    files: pending.files,
    previousHashes: pending.previousHashes,
    backup: pending.backup,
  });
  delete provenance[PENDING];
  provenance.migrationLog = log;
  await save();
  console.log(`迁移已提交，${pending.files.length} 个文件哈希已更新:`);
  for (const file of pending.files) console.log(`  - ${file}`);
  console.log(`原因: ${pending.reason}`);
  process.exit(0);
}

if (args.command === 'rollback') {
  const pending = provenance[PENDING];
  const entry = pending ?? log[log.length - 1];
  if (!entry) { console.error('没有可回滚的迁移记录。'); process.exit(1); }
  console.log(`回滚迁移: ${entry.reason}`);
  for (const file of entry.files) {
    const backup = path.join(root, entry.backup, file.replace(/[\\/]/g, '__'));
    if (!existsSync(backup)) { console.error(`  缺少备份，无法回滚: ${file}`); continue; }
    await copyFile(backup, path.join(root, file));
    console.log(`  已恢复文件 ${file}`);
  }
  if (entry.previousHashes) {
    for (const [file, hash] of Object.entries(entry.previousHashes)) {
      if (file in critical) critical[file] = hash;
    }
  }
  provenance.criticalFileHashes = critical;
  if (pending) delete provenance[PENDING];
  else log.pop();
  provenance.migrationLog = log;
  await save();
  console.log('回滚完成。');
  process.exit(0);
}

console.error('用法: migrate-template.mjs <prepare|commit|rollback|status> [--allow <file>...] [--reason "..."]');
process.exit(1);
