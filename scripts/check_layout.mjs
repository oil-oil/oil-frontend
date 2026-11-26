#!/usr/bin/env node
/**
 * Zero-dependency universal layout & overflow checker for any web/WebView project.
 *
 * Uses Playwright if already installed in the current project or via PLAYWRIGHT_MODULE,
 * injects `audit_layout.js`, and audits URLs / local HTML files / static dist dirs
 * across viewports and DPRs without modifying the target project.
 *
 * Examples:
 *   node scripts/check_layout.mjs --url http://127.0.0.1:3000 --viewport 1280x800,390x844 --dpr 1,1.5
 *   node scripts/check_layout.mjs --file path/to/index.html --viewport 1440x900,390x844
 *   node scripts/check_layout.mjs --dir path/to/dist --route "/?snapshot=welcome&lang=en" --viewport 1280x800,940x640 --dpr 1,1.5
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIT_SCRIPT_PATH = path.join(__dirname, 'audit_layout.js');
const AUDIT_SCRIPT = fs.readFileSync(AUDIT_SCRIPT_PATH, 'utf8');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
};

function parseArgs(argv) {
  const opts = {
    urls: [],
    files: [],
    dir: null,
    routes: [],
    viewports: ['1280x800'],
    dprs: [1],
    waitMs: 400,
    timeoutMs: 15000,
    rootSelector: null,
    includeWarnings: true,
    stressFontScale: null,
    json: false,
    failOnError: false,
    playwrightModule: process.env.PLAYWRIGHT_MODULE || null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[++i];
    };
    if (arg === '--url') opts.urls.push(next());
    else if (arg === '--file') opts.files.push(next());
    else if (arg === '--dir') opts.dir = path.resolve(next());
    else if (arg === '--route') opts.routes.push(next());
    else if (arg === '--viewport' || arg === '--viewports') {
      opts.viewports = next().split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg === '--dpr' || arg === '--dprs') {
      opts.dprs = next().split(',').map((s) => parseFloat(s.trim())).filter((n) => n > 0);
    } else if (arg === '--wait-ms') opts.waitMs = parseInt(next(), 10);
    else if (arg === '--timeout-ms') opts.timeoutMs = parseInt(next(), 10);
    else if (arg === '--root') opts.rootSelector = next();
    else if (arg === '--no-warnings') opts.includeWarnings = false;
    else if (arg === '--stress') opts.stressFontScale = 1.15;
    else if (arg === '--font-scale') opts.stressFontScale = parseFloat(next());
    else if (arg === '--json') opts.json = true;
    else if (arg === '--fail-on-error') opts.failOnError = true;
    else if (arg === '--playwright') opts.playwrightModule = next();
    else if (arg === '--help' || arg === '-h') {
      console.log(
        [
          'Usage: node check_layout.mjs [--url URL | --file HTML | --dir DIR [--route PATH]]',
          '  --viewport 1280x800,940x640,390x844   Comma-separated WxH viewports',
          '  --dpr 1,1.5                           Comma-separated deviceScaleFactors',
          '  --stress                              Also run +15% font-size stress pass (catches Windows/i18n/bold hardcoded boxes)',
          '  --font-scale 1.15                     Custom font-size multiplier stress pass',
          '  --wait-ms 400                         Settle delay after load',
          '  --root SELECTOR                       Restrict audit root (default body)',
          '  --no-warnings                         Only report errors',
          '  --playwright PATH                     Explicit playwright module path',
          '  --json                                Output full JSON report',
          '  --fail-on-error                       Exit non-zero when errors > 0',
        ].join('\n')
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function findFallbackExecutable() {
  const cacheRoots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'),
    path.join(os.homedir(), '.cache', 'ms-playwright'),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ms-playwright') : null,
  ].filter(Boolean);

  for (const root of cacheRoots) {
    if (!fs.existsSync(root)) continue;
    const dirs = fs
      .readdirSync(root)
      .filter((d) => /^chromium(_headless_shell)?-\d+$/.test(d))
      .sort()
      .reverse();
    for (const d of dirs) {
      const base = path.join(root, d);
      const subCandidates = [
        path.join(base, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'),
        path.join(base, 'chrome-headless-shell-mac-x64', 'chrome-headless-shell'),
        path.join(base, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
        path.join(base, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
        path.join(base, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
        path.join(base, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        path.join(base, 'chrome-linux', 'chrome'),
        path.join(base, 'chrome-win', 'chrome.exe'),
      ];
      for (const candidate of subCandidates) {
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }

  const systemCandidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  for (const candidate of systemCandidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

async function launchBrowser(chromium) {
  try {
    return await chromium.launch({ headless: true });
  } catch (primaryErr) {
    const exe = findFallbackExecutable();
    if (exe) {
      return await chromium.launch({ headless: true, executablePath: exe });
    }
    for (const channel of ['chrome', 'msedge']) {
      try {
        return await chromium.launch({ headless: true, channel });
      } catch {
        // try next channel
      }
    }
    throw primaryErr;
  }
}

function loadPlaywright(explicitPath) {
  const candidates = [];
  if (explicitPath) candidates.push(explicitPath);

  // Walk upward from cwd looking for node_modules/playwright or @playwright/test
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    candidates.push(path.join(dir, 'node_modules', 'playwright'));
    candidates.push(path.join(dir, 'node_modules', '@playwright', 'test'));
    candidates.push(path.join(dir, 'ui', 'node_modules', 'playwright'));
    candidates.push(path.join(dir, 'ui', 'node_modules', '@playwright', 'test'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const req = createRequire(import.meta.url);
  for (const modName of ['playwright', '@playwright/test', ...candidates]) {
    try {
      const mod = req(modName);
      if (mod?.chromium) return mod.chromium;
    } catch {
      // try next candidate
    }
  }
  throw new Error(
    'Playwright not found. Pass --playwright <path/to/playwright> or set PLAYWRIGHT_MODULE, ' +
      'or inject scripts/audit_layout.js directly into Chrome DevTools / ego-browser eval.'
  );
}

function startStaticServer(rootDir) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlObj = new URL(req.url || '/', 'http://127.0.0.1');
      let rel = decodeURIComponent(urlObj.pathname).replace(/^\/+/, '');
      let filePath = path.resolve(rootDir, rel);
      const relCheck = path.relative(rootDir, filePath);
      if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, 'index.html');
      }
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        // SPA fallback to root index.html when route has no file extension
        if (!path.extname(rel) && fs.existsSync(path.join(rootDir, 'index.html'))) {
          filePath = path.join(rootDir, 'index.html');
        } else {
          res.writeHead(404).end('Not found');
          return;
        }
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function parseViewport(spec) {
  const m = /^(\d+)x(\d+)$/i.exec(spec);
  if (!m) throw new Error(`Invalid viewport "${spec}", expected WxH (e.g. 1280x800)`);
  return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const targets = [];
  let server = null;

  try {
    for (const u of opts.urls) targets.push({ label: u, url: u });
    for (const f of opts.files) {
      const abs = path.resolve(f);
      targets.push({ label: f, url: pathToFileURL(abs).href });
    }
    if (opts.dir) {
      server = await startStaticServer(opts.dir);
      const routes = opts.routes.length ? opts.routes : ['/'];
      for (const r of routes) {
        const clean = r.startsWith('/') ? r : '/' + r;
        targets.push({ label: clean, url: server.baseUrl + clean });
      }
    }

    if (targets.length === 0) {
      throw new Error('Provide at least one --url, --file, or --dir target.');
    }

    const chromium = loadPlaywright(opts.playwrightModule);
    const browser = await launchBrowser(chromium);
    const runs = [];
    let totalErrors = 0;
    let totalWarnings = 0;

    try {
      for (const vpSpec of opts.viewports) {
        const viewport = parseViewport(vpSpec);
        for (const dpr of opts.dprs) {
          const context = await browser.newContext({
            viewport,
            deviceScaleFactor: dpr,
          });
          const page = await context.newPage();
          for (const target of targets) {
            await page.goto(target.url, {
              waitUntil: 'networkidle',
              timeout: opts.timeoutMs,
            }).catch(() =>
              page.goto(target.url, {
                waitUntil: 'load',
                timeout: opts.timeoutMs,
              })
            );
            await page.evaluate(() => document.fonts?.ready).catch(() => {});
            if (opts.waitMs > 0) await page.waitForTimeout(opts.waitMs);

            const report = await page.evaluate(
              ({ script, rootSelector, includeWarnings }) => {
                // eslint-disable-next-line no-eval
                (0, eval)(script);
                return globalThis.__oilAuditLayout({
                  rootSelector: rootSelector || undefined,
                  includeWarnings,
                });
              },
              {
                script: AUDIT_SCRIPT,
                rootSelector: opts.rootSelector,
                includeWarnings: opts.includeWarnings,
              }
            );

            totalErrors += report.summary?.errors || 0;
            totalWarnings += report.summary?.warnings || 0;
            runs.push({
              target: target.label,
              mode: 'normal',
              viewport: `${viewport.width}x${viewport.height}`,
              dpr,
              summary: report.summary,
              issues: report.issues,
            });

            if (opts.stressFontScale && opts.stressFontScale > 1) {
              const stressReport = await page.evaluate(
                ({ scale, rootSelector, includeWarnings }) => {
                  // Scale each element's computed font-size proportionally (works for both px and rem CSS)
                  const els = Array.from(document.querySelectorAll('body, body *'));
                  const snapshots = [];
                  for (const el of els) {
                    const fs = parseFloat(getComputedStyle(el).fontSize);
                    if (fs > 0) snapshots.push([el, fs]);
                  }
                  for (const [el, fs] of snapshots) {
                    el.style.setProperty('font-size', `${(fs * scale).toFixed(2)}px`, 'important');
                  }
                  return globalThis.__oilAuditLayout({
                    rootSelector: rootSelector || undefined,
                    includeWarnings,
                  });
                },
                {
                  scale: opts.stressFontScale,
                  rootSelector: opts.rootSelector,
                  includeWarnings: opts.includeWarnings,
                }
              );
              totalErrors += stressReport.summary?.errors || 0;
              totalWarnings += stressReport.summary?.warnings || 0;
              runs.push({
                target: target.label,
                mode: `stress(font×${opts.stressFontScale})`,
                viewport: `${viewport.width}x${viewport.height}`,
                dpr,
                summary: stressReport.summary,
                issues: stressReport.issues,
              });
            }
          }
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }

    if (opts.json) {
      console.log(JSON.stringify({ ok: totalErrors === 0, totalErrors, totalWarnings, runs }, null, 2));
    } else {
      for (const run of runs) {
        const badge = run.summary.errors === 0 ? 'PASS' : 'FAIL';
        const modeTag = run.mode && run.mode !== 'normal' ? ` [${run.mode}]` : '';
        console.log(
          `[${badge}] ${run.target} @ ${run.viewport} (dpr=${run.dpr})${modeTag} -> errors=${run.summary.errors}, warnings=${run.summary.warnings}`
        );
        for (const issue of run.issues.slice(0, 12)) {
          const textPart = issue.text ? ` "${issue.text}"` : '';
          console.log(
            `  - [${issue.severity}] ${issue.kind} | ${issue.selector}${textPart} | ${JSON.stringify(issue.metrics)}`
          );
        }
        if (run.issues.length > 12) {
          console.log(`  ... and ${run.issues.length - 12} more`);
        }
      }
      console.log(`\nTotal: errors=${totalErrors}, warnings=${totalWarnings} across ${runs.length} audit run(s).`);
    }

    if (opts.failOnError && totalErrors > 0) {
      process.exitCode = 1;
    }
  } finally {
    if (server) await server.close();
  }
}

main().catch((err) => {
  console.error(`check_layout error: ${err.message}`);
  process.exit(2);
});
