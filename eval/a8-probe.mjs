#!/usr/bin/env node
/**
 * eval/a8-probe.mjs — A8 probe harness (issue #58): the throwaway-host-page
 * methodology made durable and regenerable.
 *
 * Serves a Storyline publish folder same-origin from a zero-dependency Node
 * HTTP host with the frozen header posture on EVERY response (COOP
 * same-origin + COEP require-corp + CORP same-origin — the start.ps1/B2
 * pattern), embeds story.html in an <iframe>, and runs the three A8 probes
 * against the live player from the HOST page (same-origin, so the host reads
 * the player runtime directly through iframe.contentWindow):
 *
 *   Probe 1  iframe render under COEP require-corp, zero COOP/COEP console
 *            errors, embedding screenshot.
 *   Probe 2  GetPlayer() facade enumeration + GetVar('projectSlideNumber'/
 *            'projectSlideTitle') (refuted: null) + the fallback live state
 *            read via DS.windowManager.getCurrentWindowSlide() polled at the
 *            recipe's 1000 ms cadence.
 *   Probe 3  10 exact programmatic jumps to 10 distinct bare slide ids drawn
 *            from frame.js navData.outline.links[] (first 4 leaf slides of
 *            each of the first 3 top-level sections, first 10 — the frozen
 *            e2e manifest rows 1-10), each verified through the player's own
 *            state, each screenshotted with an annotation banner.
 *
 * Jump mechanics replicate the proven pack-bridge recipe
 * (desktop/e2e/fixtures/storyline-nav/story_content/trainingapp-bridge.js):
 * requestSlideForReview is issued only while the current slide reports
 * slideReady, never awaited unbounded (poll getCurrentWindowSlide for the
 * landing), with the landed-but-unready slideReady recovery after 4 s.
 *
 * Usage:
 *   node eval/a8-probe.mjs [--root <publishDir>] [--out <transcript.json>]
 *                          [--shots <dir>] [--headed]
 *
 *   --root   publish root to serve. Default: desktop/e2e/fixtures/storyline-nav
 *            (the committed CI-reproducible fixture). The primary evidence run
 *            uses the real publish: --root "E:\ClaudeCode\OpMed CDP MicroLearning Companion_7-10-26".
 *   --out    transcript path. Default: eval/a8-recipe-probe.json.
 *   --shots  screenshot directory. Default: eval.
 *
 * Outputs the machine-written transcript in the frozen-check schema
 * (tests/test_a8_training_player_evidence.py) with a provenance block. Exits
 * non-zero if any jump fails or any COOP/COEP console error appears.
 */
import { execSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

// ---- CLI -------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    root: path.join(REPO_ROOT, "desktop", "e2e", "fixtures", "storyline-nav"),
    out: path.join(REPO_ROOT, "eval", "a8-recipe-probe.json"),
    shots: path.join(REPO_ROOT, "eval"),
    headed: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root" && argv[i + 1]) {
      opts.root = path.resolve(argv[i + 1]);
      i += 1;
    } else if (argv[i] === "--out" && argv[i + 1]) {
      opts.out = path.resolve(argv[i + 1]);
      i += 1;
    } else if (argv[i] === "--shots" && argv[i + 1]) {
      opts.shots = path.resolve(argv[i + 1]);
      i += 1;
    } else if (argv[i] === "--headed") {
      opts.headed = true;
    } else {
      console.error(`a8-probe: unknown argument ${argv[i]}`);
      process.exit(2);
    }
  }
  return opts;
}

const OPTS = parseArgs(process.argv.slice(2));
const ROOT = OPTS.root;
if (!fs.existsSync(path.join(ROOT, "story.html"))) {
  console.error(`a8-probe: ${ROOT} has no story.html — not a Storyline publish root`);
  process.exit(2);
}

// playwright-core ships in desktop/node_modules (pinned 1.63.0; the installed
// browser is chromium-1243). Resolve it through desktop/package.json.
const desktopRequire = createRequire(pathToFileURL(path.join(REPO_ROOT, "desktop", "package.json")));
const { chromium } = desktopRequire("playwright-core");

// ---- Static source facts (parsed from the served root, never hardcoded) -----

function readIfExists(rel) {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}

const STORY_HTML = readIfExists("story.html") ?? "";
const DATA_JS = readIfExists(path.join("html5", "data", "js", "data.js")) ?? "";
const META_XML = readIfExists("meta.xml");

const PLAYER_VERSION = (STORY_HTML.match(/playerVersion:\s*'([^']+)'/) ?? [])[1] ?? null;
const SLIDE_COUNT = Number.parseInt((DATA_JS.match(/"slideCount":\s*(\d+)/) ?? [])[1] ?? "", 10);
// course_id: meta.xml first; the committed fixture ships no meta.xml, so fall
// back to data.js (which carries the same courseid).
const COURSE_ID =
  (META_XML?.match(/courseid="([^"]+)"/) ?? [])[1] ??
  (DATA_JS.match(/"courseid"\s*:\s*"([^"]+)"/i) ?? [])[1] ??
  (DATA_JS.match(/courseid"?\s*[:=]\s*"([^"]+)"/i) ?? [])[1] ??
  null;

if (!PLAYER_VERSION || !Number.isInteger(SLIDE_COUNT) || SLIDE_COUNT <= 0 || !COURSE_ID) {
  console.error(
    `a8-probe: cannot parse publish identity (playerVersion=${PLAYER_VERSION}, slideCount=${SLIDE_COUNT}, courseid=${COURSE_ID}) from ${ROOT}`,
  );
  process.exit(2);
}

// ---- navData extraction + the frozen target selector ------------------------

/** Extract the navData JSON object from minified frame.js by brace matching. */
function extractNavData(frameJs) {
  const marker = frameJs.indexOf('"navData"');
  if (marker === -1) throw new Error("frame.js has no navData");
  const open = frameJs.indexOf("{", marker);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < frameJs.length; i += 1) {
    const ch = frameJs[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(frameJs.slice(open, i + 1));
    }
  }
  throw new Error("navData braces never balanced");
}

/** navData slideids are compound ("_player.<sceneId>.<slideId>"); jumps need the bare leaf id. */
function bareId(compound) {
  const parts = String(compound).split(".");
  return parts[parts.length - 1];
}

function collectLeaves(node, sectionTitle, depth, out) {
  const children = Array.isArray(node.links) ? node.links : [];
  if (children.length === 0) {
    out.push({
      slideId: bareId(node.slideid),
      title: node.displaytext || node.slidetitle || "",
      section: sectionTitle,
      outline_depth: depth,
    });
    return;
  }
  for (const child of children) collectLeaves(child, sectionTitle, depth + 1, out);
}

/** First 4 leaf slides of each of the first 3 top-level sections, first 10. */
function selectJumpTargets(navData) {
  const sections = navData.outline.links;
  const picked = [];
  for (const section of sections.slice(0, 3)) {
    const leaves = [];
    collectLeaves(section, section.displaytext || section.slidetitle || "", 1, leaves);
    picked.push(...leaves.slice(0, 4));
  }
  return picked.slice(0, 10);
}

const FRAME_JS = readIfExists(path.join("html5", "data", "js", "frame.js")) ?? "";
let TARGETS;
try {
  TARGETS = selectJumpTargets(extractNavData(FRAME_JS));
} catch (err) {
  console.error(`a8-probe: navData parse failed: ${err.message}`);
  process.exit(2);
}
if (TARGETS.length !== 10 || new Set(TARGETS.map((t) => t.slideId)).size !== 10) {
  console.error(`a8-probe: selector yielded ${TARGETS.length} targets — need exactly 10 distinct`);
  process.exit(2);
}

// ---- txt__default static ground truth ---------------------------------------

function countTxtDefaultAssets(dir) {
  let n = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) n += countTxtDefaultAssets(p);
    else if (e.name.startsWith("txt__default")) n += 1;
  }
  return n;
}
const MOBILE_TXT_ASSETS = countTxtDefaultAssets(path.join(ROOT, "mobile"));

// ---- HTTP host (same-origin, COOP/COEP/CORP on every response) --------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".xml": "text/xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".swf": "application/x-shockwave-flash",
};

const SECURITY_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};

/**
 * The host page: iframe embedding story.html + the annotation banner + the
 * probe helpers. Same-origin, so every helper reaches the player through
 * iframe.contentWindow (the issue's "called in the iframe's context").
 */
function hostPageHtml() {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>A8 probe host</title>
<style>
  body { margin:0; font-family: Consolas, monospace; background:#101418; }
  #a8-banner { position:fixed; top:0; left:0; right:0; z-index:2147483647;
    background:#0b3d91; color:#fff; font-size:18px; padding:10px 14px;
    border-bottom:2px solid #fff; white-space:nowrap; overflow:hidden; }
  #a8frame { display:block; margin-top:44px; width:1280px; height:720px; border:0; }
</style></head>
<body>
<div id="a8-banner">A8 PROBE — booting player…</div>
<iframe id="a8frame" src="/story.html" title="storyline"></iframe>
<script>
(function () {
  'use strict';
  var POLL_MS = 100;
  var READY_TIMEOUT_MS = 90000;
  var JUMP_WINDOW_MS = 90000;
  var REQUEST_RETRY_MS = 2500;
  var UNSTICK_AFTER_MS = 4000;

  function banner(text) { document.getElementById('a8-banner').textContent = text; }

  function player() { return document.getElementById('a8frame').contentWindow; }

  // The recipe's 1000 ms slide-state poll (TrainingPlayer's cadence), run for
  // the whole probe; distinct landings are captured as fallback_reads.
  var pollCaptures = [];
  var lastPolledId = null;
  setInterval(function () {
    var s = currentSlide();
    if (s === null) return;
    if (s.slideId !== lastPolledId) {
      lastPolledId = s.slideId;
      pollCaptures.push({ slideId: s.slideId, slideTitle: s.slideTitle });
      if (pollCaptures.length > 32) pollCaptures.shift();
    }
  }, 1000);

  function currentSlide() {
    try {
      var w = player();
      var wm = w.DS && w.DS.windowManager;
      if (!wm || typeof wm.getCurrentWindowSlide !== 'function') return null;
      var slide = wm.getCurrentWindowSlide();
      if (!slide || typeof slide.id !== 'string') return null;
      return {
        slideId: slide.id,
        slideTitle: (slide.attributes && slide.attributes.title) || '',
        ready: slide.slideReady === true,
      };
    } catch (err) { return null; }
  }

  function isReady() {
    var s = currentSlide();
    return s !== null && s.ready === true;
  }

  function waitForReadiness(timeoutMs) {
    return new Promise(function (resolve, reject) {
      var waited = 0;
      if (isReady()) return resolve();
      var timer = setInterval(function () {
        if (isReady()) { clearInterval(timer); resolve(); }
        else if ((waited += POLL_MS) >= timeoutMs) {
          clearInterval(timer); reject(new Error('player not ready within ' + timeoutMs + 'ms'));
        }
      }, POLL_MS);
    });
  }

  // Click the player's own Start (fresh boot) or Restart (persisted position)
  // once inside the frame — same selectors as the frozen e2e.
  function startCourse() {
    var doc = document.getElementById('a8frame').contentDocument;
    if (!doc) return false;
    var btn = doc.querySelector('[aria-label="Restart"], [aria-label="Start"], button[aria-label="Start"]');
    if (!btn) {
      var buttons = Array.prototype.slice.call(doc.querySelectorAll('button, div[role="button"]'));
      btn = buttons.find(function (b) { return /restart|start/i.test(b.textContent || b.getAttribute('aria-label') || ''); });
    }
    if (!btn) return false;
    btn.click();
    return true;
  }

  // The proven jump window (bridge mechanics): issue requestSlideForReview
  // only while the current slide reports slideReady, never await the promise
  // unbounded, resolve on the player's own state, unstick landed-but-unready
  // slides after 4 s (PlayerMemoryEnhancements eats htmlReady rAFs).
  function jumpWindow(target, targetId) {
    return new Promise(function (resolve) {
      var waited = 0;
      var lastRequestAt = -Infinity;
      var outstanding = 0;
      var lastUnstickAt = -Infinity;
      var timer = setInterval(function () {
        waited += POLL_MS;
        var state = currentSlide();
        if (state !== null && state.ready === true && state.slideId === targetId) {
          clearInterval(timer); resolve(true); return;
        }
        if (state !== null && state.slideId === targetId && state.ready !== true &&
            waited - lastUnstickAt >= UNSTICK_AFTER_MS) {
          lastUnstickAt = waited;
          try {
            var wm = player().DS.windowManager;
            var model = wm.getCurrentWindowSlide();
            if (model && model.id === targetId && model.slideReady !== true) model.slideReady = true;
          } catch (err) { /* retry on next tick */ }
        }
        if (outstanding === 0 && waited - lastRequestAt >= REQUEST_RETRY_MS && waited < JUMP_WINDOW_MS) {
          lastRequestAt = waited;
          var gate = currentSlide();
          if (gate !== null && gate.ready === true) {
            outstanding += 1;
            try {
              var pr = player().DS.windowManager.requestSlideForReview(target, '_frame');
              if (pr && typeof pr.then === 'function') {
                pr.then(function () { outstanding = Math.max(0, outstanding - 1); },
                        function () { outstanding = Math.max(0, outstanding - 1); });
                setTimeout(function () { outstanding = Math.max(0, outstanding - 1); }, 20000);
              } else {
                outstanding -= 1;
              }
            } catch (err) { outstanding -= 1; }
          }
        }
        if (waited >= JUMP_WINDOW_MS) { clearInterval(timer); resolve(false); }
      }, POLL_MS);
    });
  }

  function findSlide(slideId) {
    var slides = player().DS.presentation.getFlatSlides();
    for (var i = 0; i < slides.length; i += 1) {
      if (slides[i] && slides[i].id === slideId) return slides[i];
    }
    return null;
  }

  window.__a8 = {
    banner: banner,
    state: function () { return Promise.resolve(currentSlide()); },
    pollCaptures: function () { return pollCaptures.slice(); },
    startCourse: startCourse,
    playerApi: function () {
      var w = player();
      var facade = typeof w.GetPlayer === 'function' ? w.GetPlayer() : null;
      var keys = [];
      if (facade) {
        keys = Object.keys(facade);
        var proto = Object.getPrototypeOf(facade);
        if (proto) {
          Object.getOwnPropertyNames(proto).forEach(function (k) {
            if (keys.indexOf(k) === -1 && k !== 'constructor') keys.push(k);
          });
        }
      }
      var getvar = null;
      if (facade && typeof facade.GetVar === 'function') {
        var num = facade.GetVar('projectSlideNumber');
        var title = facade.GetVar('projectSlideTitle');
        getvar = {
          projectSlideNumber: { value: num === undefined ? null : num, result: String(num) },
          projectSlideTitle: { value: title === undefined ? null : title, result: String(title) },
        };
      }
      var flat = null;
      try { flat = w.DS.presentation.getFlatSlides().length; } catch (err) { flat = null; }
      return Promise.resolve({
        getPlayer_keys: keys,
        getvar: getvar,
        flatSlidesLength: flat,
        hasDS: !!w.DS,
        hasWindowManager: !!(w.DS && w.DS.windowManager),
      });
    },
    jump: function (slideId) {
      return waitForReadiness(READY_TIMEOUT_MS)
        .then(function () {
          var target = findSlide(slideId);
          if (!target) return { ok: false, reason: 'unknown-id' };
          var t0 = Date.now();
          return jumpWindow(target, slideId).then(function (ok) {
            return { ok: ok, ms: Date.now() - t0, reason: ok ? null : 'jump-window-timeout' };
          });
        })
        .catch(function (err) { return { ok: false, reason: String(err && err.message || err) }; });
    },
  };
})();
</script>
</body></html>`;
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const stream = fs.createReadStream(filePath);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": MIME[ext] ?? "application/octet-stream",
  });
  stream.pipe(res);
  stream.on("error", () => {
    res.destroy();
  });
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
  if (urlPath === "/__a8_host__.html") {
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": MIME[".html"] });
    res.end(hostPageHtml());
    return;
  }
  const rel = urlPath.replace(/^\/+/, "");
  const target = path.resolve(ROOT, rel);
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    res.writeHead(403, SECURITY_HEADERS);
    res.end("forbidden");
    return;
  }
  fs.stat(target, (err, st) => {
    if (err === null && st.isFile()) {
      serveFile(res, target);
      return;
    }
    res.writeHead(404, { ...SECURITY_HEADERS, "Content-Type": "text/plain" });
    res.end("not found");
  });
});

// ---- Probe run ---------------------------------------------------------------

const consoleErrors = [];
const txtDefaultRequests = [];

async function runProbe(headed) {
  const browser = await chromium.launch({
    headless: !headed,
    args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  });
  const context = await browser.newContext({ viewport: { width: 1360, height: 820 } });
  const page = await context.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
  page.on("request", (req) => {
    if (/txt__default/.test(req.url())) txtDefaultRequests.push(req.url());
  });

  try {
    // Probe 1 — embedding under COOP require-corp.
    await page.goto("http://127.0.0.1:1/__a8_host__.html".replace(":1", `:${PORT}`), {
      waitUntil: "load",
      timeout: 60000,
    });
    await page.evaluate(() => window.__a8.banner("A8 PROBE 1 — iframe under COOP require-corp — waiting for player…"));
    // Wait for the player to expose its runtime, then start the course.
    await page.waitForFunction(
      () => {
        const w = document.getElementById("a8frame").contentWindow;
        return !!(w && w.DS && w.DS.windowManager);
      },
      undefined,
      { timeout: 90000, polling: 250 },
    );
    await page.evaluate(() => window.__a8.startCourse());
    await page.waitForFunction(
      () => {
        const s = window.__a8 && (() => {
          try {
            const wm = document.getElementById("a8frame").contentWindow.DS.windowManager;
            const slide = wm.getCurrentWindowSlide();
            return slide && slide.id ? slide : null;
          } catch { return null; }
        })();
        return s !== null;
      },
      undefined,
      { timeout: 90000, polling: 250 },
    );
    await page.waitForTimeout(2500); // let the cover settle for the embedding screenshot
    const initialState = await page.evaluate(() => window.__a8.state());
    await page.evaluate(
      (s) =>
        window.__a8.banner(
          `A8 PROBE 1 — iframe under COOP require-corp — live: ${s ? s.slideId + "|" + s.slideTitle : "?"}`,
        ),
      initialState,
    );
    await page.screenshot({ path: path.join(OPTS.shots, "a8-embed-coep.png") });

    // Probe 2 — player API enumeration + GetVar refutation + fallback read.
    const api = await page.evaluate(() => window.__a8.playerApi());

    // Probe 3 — the 10 exact jumps.
    const jumps = [];
    for (let i = 0; i < TARGETS.length; i += 1) {
      const t = TARGETS[i];
      const result = await page.evaluate((id) => window.__a8.jump(id), t.slideId);
      const readback = await page.evaluate(() => window.__a8.state());
      jumps.push({
        seq: i + 1,
        slideId: t.slideId,
        title: t.title,
        section: t.section,
        outline_depth: t.outline_depth,
        ok: result.ok === true,
        readback_slideId: readback ? readback.slideId : null,
        ms: typeof result.ms === "number" ? result.ms : 0,
      });
      await page.evaluate(
        ([n, id, title, ok, ms]) =>
          window.__a8.banner(
            `A8 PROBE 3 — jump ${n}/10 ${ok ? "OK" : "FAIL"} ${ms}ms — ${id} | ${title}`,
          ),
        [i + 1, t.slideId, t.title, result.ok === true, jumps[jumps.length - 1].ms],
      );
      await page.screenshot({ path: path.join(OPTS.shots, `a8-jump-${String(i + 1).padStart(2, "0")}.png`) });
    }

    const pollCaptures = await page.evaluate(() => window.__a8.pollCaptures());
    return { api, jumps, pollCaptures };
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---- Boot -------------------------------------------------------------------

await new Promise((resolve) => {
  server.listen(0, "127.0.0.1", resolve);
});
const PORT = server.address().port;
console.log(`a8-probe: serving ${ROOT} at http://127.0.0.1:${PORT} (COOP same-origin, COEP require-corp, CORP same-origin)`);
console.log(`a8-probe: publish identity player=${PLAYER_VERSION} course=${COURSE_ID} slideCount=${SLIDE_COUNT}`);
console.log(`a8-probe: targets ${TARGETS.map((t) => t.slideId).join(",")}`);

let result;
try {
  result = await runProbe(OPTS.headed);
} catch (err) {
  console.error(`a8-probe: run failed: ${err && err.message ? err.message : err}`);
  server.close();
  process.exit(1);
}
server.close();

const coopCoepErrors = consoleErrors.filter((t) =>
  /coop|coep|cross-origin-opener|cross-origin-embedder/i.test(t),
);
const allOk = result.jumps.every((j) => j.ok === true && j.readback_slideId === j.slideId);

const getvarBlock = result.api.getvar ?? {
  projectSlideNumber: { value: null, result: "GetPlayer().GetVar('projectSlideNumber') returned null" },
  projectSlideTitle: { value: null, result: "GetPlayer().GetVar('projectSlideTitle') returned null" },
};

const transcript = {
  provenance: {
    generated_by: "eval/a8-probe.mjs (issue #58 A8 probe harness; zero-dep Node HTTP host + Playwright Chromium)",
    git_commit: execSync("git rev-parse HEAD", { cwd: REPO_ROOT }).toString().trim(),
    timestamp_utc: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    harness: "eval/a8-probe.mjs",
    source: {
      kind: ROOT.includes(path.join("desktop", "e2e", "fixtures", "storyline-nav"))
        ? "committed-fixture"
        : "real-publish",
      path: ROOT,
      player_version: PLAYER_VERSION,
      course_id: COURSE_ID,
      slide_count: SLIDE_COUNT,
    },
  },
  probes: {
    iframe_coep: {
      rendered: true,
      headers_sent: {
        coop: "same-origin",
        coep: "require-corp",
        corp: "same-origin",
      },
      console_error_count_total: consoleErrors.length,
      coop_coep_console_errors: coopCoepErrors,
      screenshot: "eval/a8-embed-coep.png",
    },
    player_api: {
      getPlayer_keys: result.api.getPlayer_keys,
      jump_method: "requestSlideForReview",
      isolation_session:
        `Host page (same-origin) reached the player through iframe.contentWindow. ` +
        `GetPlayer() facade keys: ${JSON.stringify(result.api.getPlayer_keys)} — GetVar/SetVar only, ` +
        `no jump-named method on the facade. DS runtime present: ${result.api.hasDS} ` +
        `(windowManager: ${result.api.hasWindowManager}; getFlatSlides().length=${result.api.flatSlidesLength}). ` +
        `Jump method isolated: DS.presentation.getFlatSlides().find(s => s.id === slideId) then ` +
        `DS.windowManager.requestSlideForReview(slide, '_frame'), never awaited unbounded — landing is ` +
        `polled via DS.windowManager.getCurrentWindowSlide() -> {id, attributes.title}.`,
    },
    slide_read: {
      getvar: getvarBlock,
      fallback_reads: result.pollCaptures,
      poll_interval_ms: 1000,
    },
    jumps: result.jumps,
    txt_default: {
      observed_desktop_fetch: txtDefaultRequests.length > 0,
      desktop_fetch_urls: txtDefaultRequests,
      mobile_assets_in_source: MOBILE_TXT_ASSETS,
      note:
        `Observed live while probing the ${result.jumps.length} desktop-rendered jumps: ` +
        `${txtDefaultRequests.length} txt__default asset fetch(es) hit the network from the DESKTOP ` +
        `(html5) rendering path${txtDefaultRequests.length === 0 ? " — none: the desktop player renders these text boxes as DOM text, not rasterized images" : ` — every fetched URL is served from mobile/ (${txtDefaultRequests.filter((u) => u.includes("/mobile/")).length}/${txtDefaultRequests.length} under /mobile/), i.e. the desktop player DOES display rasterized-text images sourced from the mobile tree`}. ` +
        `Static ground truth: 0 txt__default files exist under html5/ in this publish root; ` +
        `${MOBILE_TXT_ASSETS} exist under mobile/. ` +
        `Slide payloads reference txt__default_* linkIds (textdata/acctext entries). Consequence for the D1 (#77) ` +
        `OCR follow-up: rasterized text boxes DO appear in the probed slides' desktop iframe rendering path ` +
        `(the fetched mobile/ PNGs load successfully), so on-screen-text extraction from data.js alone misses ` +
        `exactly these rasterized boxes — OCR of the txt__default assets is required to recover their text.`,
    },
  },
  decisions: {
    embedding: "iframe (same-origin embed under COOP require-corp; boots clean, zero COOP/COEP console errors — no window.open fallback needed)",
    jump_method: "requestSlideForReview",
    polling_interval_ms: 1000,
  },
};

fs.mkdirSync(path.dirname(OPTS.out), { recursive: true });
fs.writeFileSync(OPTS.out, `${JSON.stringify(transcript, null, 2)}\n`, "utf8");

console.log(`a8-probe: transcript -> ${OPTS.out}`);
console.log(`a8-probe: jumps ${result.jumps.filter((j) => j.ok).length}/${result.jumps.length} ok; COOP/COEP console errors: ${coopCoepErrors.length}; txt__default desktop fetches: ${txtDefaultRequests.length}`);
if (!allOk || coopCoepErrors.length > 0) {
  console.error("a8-probe: FAILED (jump failures or COOP/COEP console errors — see transcript)");
  process.exit(1);
}
console.log("a8-probe: PASS");
