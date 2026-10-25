import type { TypingStatus } from '../shared/contracts';
import path from 'node:path';

interface UiohookEvent {
  keycode?: number;
}

interface UiohookInstance {
  on(event: 'keydown', callback: (e: UiohookEvent) => void): void;
  start(): void;
  stop(): void;
}

function loadUiohook(): UiohookInstance | null {
  // 1) 开发模式：从 node_modules 正常加载
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('uiohook-napi');
    if (mod?.uIOhook && typeof mod.uIOhook.start === 'function') {
      return mod.uIOhook as UiohookInstance;
    }
  } catch {
    // not in node_modules, fall through
  }
  // 2) 打包模式：从 resources/uiohook-napi 加载（package.json 受哈希保护，
  //    无法声明为依赖，因此打包后手动复制到 resources 目录）
  try {
    if (typeof process.resourcesPath === 'string' && process.resourcesPath) {
      const bundled = path.join(process.resourcesPath, 'uiohook-napi');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(bundled);
      if (mod?.uIOhook && typeof mod.uIOhook.start === 'function') {
        return mod.uIOhook as UiohookInstance;
      }
    }
  } catch {
    // not bundled either
  }
  return null;
}

export class TypingListener {
  private running = false;
  private callback: (() => void) | undefined;
  private uiohook: UiohookInstance | null = null;
  private lastEmit = 0;
  private readonly throttleMs = 300;

  start(enabled: boolean, callback: () => void): TypingStatus {
    this.callback = callback;
    if (!enabled) {
      this.running = false;
      return { enabled: false, reason: 'disabled-by-settings' };
    }
    try {
      // 动态加载 uiohook-napi；未安装时自动降级，不破坏构建
      this.uiohook = loadUiohook();
      if (!this.uiohook) {
        this.running = false;
        return { enabled: false, reason: 'not-available' };
      }
      this.uiohook.on('keydown', () => {
        const now = Date.now();
        if (now - this.lastEmit >= this.throttleMs) {
          this.lastEmit = now;
          this.callback?.();
        }
      });
      this.uiohook.start();
      this.running = true;
      return { enabled: true, reason: 'ok' };
    } catch {
      this.uiohook = null;
      this.running = false;
      return { enabled: false, reason: 'not-available' };
    }
  }

  stop(): void {
    if (this.uiohook && this.running) {
      try {
        this.uiohook.stop();
      } catch {
        // ignore stop errors
      }
    }
    this.running = false;
    this.callback = undefined;
    this.uiohook = null;
  }
}
