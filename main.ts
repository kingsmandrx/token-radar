// Token Radar — entrypoint (Node 22, standard library only).
//
// What this program does, end to end:
//   1. Reads the sealed snapshot (DefiLlama protocol index, one JSON file) from
//      /input/snapshot.json, or from the path given by --input.
//   2. Scores every pre-token protocol with the value model in lib/model.ts and
//      builds the ranked board (watchlist first, then the early radar, with the
//      live-token protocols set aside).
//   3. Writes the board to /output/board.json and the dashboard's data to
//      /output/data.js, copies this repo's dashboard/ and screenshots/ into
//      /output, and finally writes /output/dossier.json — the summary the judge
//      reads — with the vendored make.fun library.
//
// The dashboard is a static page (no framework, no network): dashboard/index.html,
// dashboard/app.css and dashboard/app.js read /output/data.js, which is written
// here from the same board the gate checks. The model, the page and the farm
// plans are ours; the gate's shape (board.json, data.js, dashboard/, screenshots/,
// dossier.json) is fixed by the competition.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

// ---------------------------------------------------------------------------
// Caps the gate enforces (see the competition's reference/gate.json).
// ---------------------------------------------------------------------------

/** Largest dashboard text the dossier keeps, in bytes. */
const TEXT_MAX_BYTES = 65_536;
/** Screenshots: at most 4 files, each at most 512 KiB. */
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
/** File names the gate accepts for screenshots. */
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

// ---------------------------------------------------------------------------
// Command-line flags.
// ---------------------------------------------------------------------------

/** Directory this file lives in (the repository root). */
const repoRoot = fileURLToPath(new URL('.', import.meta.url));

/**
 * Value of `--name <value>` or `--name=<value>` on the command line,
 * or `fallback` when the flag is absent.
 */
function flagValue(name: string, fallback: string): string {
  const spaced = process.argv.indexOf(`--${name}`);
  if (spaced >= 0 && spaced + 1 < process.argv.length) return process.argv[spaced + 1]!;
  const joined = process.argv.find((entry) => entry.startsWith(`--${name}=`));
  return joined === undefined ? fallback : joined.slice(name.length + 3);
}

// Where the sealed snapshot lives: a file, or a directory holding snapshot.json.
const inputPath = flagValue('input', '/input');
const snapshotPath = inputPath.endsWith('.json') ? inputPath : join(inputPath, 'snapshot.json');
if (!existsSync(snapshotPath)) {
  process.stderr.write(`token radar: no snapshot at ${snapshotPath}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}

// Where the outputs go: --output, else MAKEFUN_OUTPUT_DIR, else /output.
const outputDir = flagValue('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

// ---------------------------------------------------------------------------
// Snapshot: parse, then validate before the model ever sees it.
// ---------------------------------------------------------------------------

const sealed = parseSnapshot(readFileSync(snapshotPath, 'utf8'));

/**
 * Refuse a snapshot that cannot produce a valid board, with a message that
 * names the problem instead of a cryptic failure later. The sealed snapshot
 * passes all three checks; this guards the entry against a truncated or
 * hand-edited input.
 */
function validateSnapshot(snapshot: ReturnType<typeof parseSnapshot>): void {
  if (!Array.isArray(snapshot.protocols) || snapshot.protocols.length === 0) {
    process.stderr.write('token radar: snapshot has no protocols: expected a non-empty protocols array\n');
    process.exit(2);
  }
  for (let i = 0; i < snapshot.protocols.length; i++) {
    const protocol = snapshot.protocols[i]!;
    const hasSlug = typeof protocol.slug === 'string' && protocol.slug.length > 0;
    const hasName = typeof protocol.name === 'string' && protocol.name.length > 0;
    const hasTvl = typeof protocol.tvl_usd === 'number' && Number.isFinite(protocol.tvl_usd);
    if (!hasSlug || !hasName || !hasTvl) {
      process.stderr.write(`token radar: protocol at index ${i} is missing slug, name or tvl_usd\n`);
      process.exit(2);
    }
  }
  const knownSlugs = new Set(snapshot.protocols.map((protocol) => protocol.slug));
  for (const slug of snapshot.watchlist) {
    if (!knownSlugs.has(slug)) {
      process.stderr.write(`token radar: watchlist slug ${slug} is not in the snapshot protocols\n`);
      process.exit(2);
    }
  }
}

validateSnapshot(sealed);

// ---------------------------------------------------------------------------
// Score the board and refuse it if the model broke the gate's shape.
// ---------------------------------------------------------------------------

const { board, radar } = buildRadar(sealed);
const boardProblem = boardIssue(board, sealed);
if (boardProblem !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${boardProblem}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Write the ranked board and the dashboard data.
// ---------------------------------------------------------------------------

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(outputDir, 'data.js'), dataScript(radar));

// ---------------------------------------------------------------------------
// Copy the dashboard and the screenshots into the output.
// ---------------------------------------------------------------------------

/** Copy one directory's regular files into `to`, skipping names that start with a dot. Returns the copied names. */
function copyDirectory(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const source = join(from, name);
    if (!statSync(source).isFile()) continue;
    copyFileSync(source, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyDirectory(join(repoRoot, 'dashboard'), join(outputDir, 'dashboard'));
const screenshotNames = copyDirectory(join(repoRoot, 'screenshots'), join(outputDir, 'screenshots'));
if (screenshotNames.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${screenshotNames.length} image${screenshotNames.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of screenshotNames) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Dossier last: the scorer rebuilds it from this /output and compares bytes.
// ---------------------------------------------------------------------------

writeFileSync(join(outputDir, 'dossier.json'), buildDossier(outputDir, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

// ---------------------------------------------------------------------------
// Run summary (stdout only; it never touches the output files).
// ---------------------------------------------------------------------------

const watchlistSlugs = new Set(sealed.watchlist);
const topWatchlistRow = board.find((row) => watchlistSlugs.has(row.slug));
const topWatchlistName = topWatchlistRow === undefined ? '(none)' : topWatchlistRow.name;

process.stdout.write(
  `token radar: ${sealed.protocols.length} protocols in the snapshot, ${sealed.watchlist.length} on the watchlist\n` +
    `token radar: ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside); top watchlist protocol: ${topWatchlistName}\n` +
    `token radar: wrote ${join(outputDir, 'board.json')}, ${join(outputDir, 'data.js')}, ${join(outputDir, 'dashboard')} (3 files), ${join(outputDir, 'screenshots')} (${screenshotNames.length} images) and ${join(outputDir, 'dossier.json')}\n`,
);
