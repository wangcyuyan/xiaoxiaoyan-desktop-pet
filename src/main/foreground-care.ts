/**
 * 识屏关怀（借鉴 dsh-pet-indesktop 的「主动识屏陪伴」）
 *
 * 周期探测前台应用进程：切到白名单里的应用（写代码的编辑器、办公软件等）
 * 时，桌宠冒泡关心一句。与对方实现的差别：
 *   - 关怀走好感度门控 —— 关系不够（亲密度/活力不足）时不出声
 *   - 每个应用每天最多一次、全局每小时最多一次 —— 关怀不是骚扰
 *   - 只看进程名，不截图不读窗口内容 —— 零隐私负担
 *
 * 探测方式：PowerShell 调 user32 的 GetForegroundWindow + GetWindowThreadProcessId。
 * 每次 spawn 一个隐藏的 powershell 进程，45 秒一次，开销可忽略。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** 探测间隔 */
const POLL_INTERVAL_MS = 45_000;
/** 同一应用两次关怀的最短间隔（跨天由 firedSlots 去重，这里是小时内防抖） */
const PER_APP_COOLDOWN_MS = 2 * 60 * 60_000;
/** 全局每小时最多关怀次数 */
const HOURLY_CAP = 2;

/** 取前台窗口进程名的 PS 片段（输出形如 "Code"） */
const FOREGROUND_PS = [
  "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class W{[DllImport(\"user32.dll\")]public static extern IntPtr GetForegroundWindow();[DllImport(\"user32.dll\")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);}'",
  '$h=[W]::GetForegroundWindow();$p=0;[W]::GetWindowThreadProcessId($h,[ref]$p)|Out-Null;(Get-Process -Id $p).ProcessName',
].join(';');

export interface ForegroundCareOptions {
  /** 白名单：进程名子串匹配（大小写不敏感），空数组 = 关闭 */
  apps: string[];
  /** 前台切到白名单应用时回调（进程名） */
  onCare: (processName: string) => void;
}

/** 前台探测器：只负责发现「切进了白名单应用」这件事。 */
export class ForegroundCareMonitor {
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastForeground = '';
  private readonly lastCareAt = new Map<string, number>();
  private readonly careTimestamps: number[] = [];
  private readonly apps: string[];
  private readonly onCare: (processName: string) => void;
  private probing = false;

  constructor(options: ForegroundCareOptions) {
    this.apps = options.apps.map((name) => name.toLowerCase());
    this.onCare = options.onCare;
  }

  start(): void {
    if (this.timer || this.apps.length === 0) return;
    this.timer = setInterval(() => { void this.poll(); }, POLL_INTERVAL_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async poll(): Promise<void> {
    if (this.probing) return; // 上一次探测还没回来，跳过本轮
    this.probing = true;
    try {
      const { stdout } = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', FOREGROUND_PS], {
        timeout: 10_000,
        windowsHide: true,
      });
      const processName = stdout.trim().toLowerCase();
      if (!processName || processName === this.lastForeground) return;
      const previous = this.lastForeground;
      this.lastForeground = processName;
      // 只关心「切进来」，不关心「切出去」；白名单子串匹配
      if (previous === '') return; // 启动后第一次探测不算「切换」
      if (!this.apps.some((app) => processName.includes(app))) return;
      if (!this.withinCooldown(processName)) return;
      if (!this.withinHourlyCap()) return;
      this.lastCareAt.set(processName, Date.now());
      this.careTimestamps.push(Date.now());
      this.onCare(processName);
    } catch {
      // 探测失败（锁屏/无前台窗口/权限）静默跳过
    } finally {
      this.probing = false;
    }
  }

  private withinCooldown(processName: string): boolean {
    const last = this.lastCareAt.get(processName);
    return last === undefined || Date.now() - last >= PER_APP_COOLDOWN_MS;
  }

  private withinHourlyCap(): boolean {
    const hourAgo = Date.now() - 60 * 60_000;
    while (this.careTimestamps.length > 0 && this.careTimestamps[0]! < hourAgo) this.careTimestamps.shift();
    return this.careTimestamps.length < HOURLY_CAP;
  }
}
