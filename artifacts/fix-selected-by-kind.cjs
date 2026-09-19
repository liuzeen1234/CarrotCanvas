// One-off migration: backfill generation_candidate_groups.selected_by_kind
// for existing groups so each output kind (video/image/audio) defaults to its
// latest produced asset. Fixes H3 video cards whose video track showed as
// "not selected" because the single legacy selected_asset_id pointed at audio.
//
// Usage:
//   node artifacts/fix-selected-by-kind.cjs            (dry run, prints plan)
//   node artifacts/fix-selected-by-kind.cjs --apply    (backup + write)

const fs = require('fs');
const path = require('path');
let Database;
try { Database = require('better-sqlite3'); }
catch (e) { Database = require(path.join(__dirname, '..', 'backend', 'node_modules', 'better-sqlite3')); }

const DB_PATH = path.join(__dirname, '..', 'backend', 'data', 'carrot-canvas.sqlite');
const APPLY = process.argv.includes('--apply');

if (APPLY) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(__dirname, '..', 'backend', 'data', 'backups', `carrot-canvas.before-selected-by-kind-${stamp}.sqlite`);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.copyFileSync(DB_PATH, backup);
  console.log('BACKUP ->', backup);
}

const db = new Database(DB_PATH, { readonly: !APPLY });

const groups = db.prepare(`SELECT * FROM generation_candidate_groups`).all();
const kindOf = new Map();
const assetKind = (id) => {
  if (kindOf.has(id)) return kindOf.get(id);
  const a = db.prepare(`SELECT kind FROM assets WHERE id = ?`).get(id);
  const k = a ? a.kind : null;
  kindOf.set(id, k);
  return k;
};

// For a group, find latest asset per kind. "Latest" = order candidate_asset_ids
// is appended (appendCandidates pushes newest run's ids at the end), so the last
// occurrence of a kind in candidateAssetIds is the newest. Cross-check with the
// selected run's outputs to keep the currently-selected kind stable.
let planned = 0, skipped = 0;
const update = db.prepare(`UPDATE generation_candidate_groups SET selected_by_kind = ? WHERE id = ?`);

for (const g of groups) {
  const existing = g.selected_by_kind ? JSON.parse(g.selected_by_kind) : null;
  const candidates = JSON.parse(g.candidate_asset_ids || '[]');
  const byKind = {};
  for (const id of candidates) { const k = assetKind(id); if (k) byKind[k] = id; } // last wins = newest
  // preserve currently selected asset for its own kind (respect prior manual choice)
  if (g.selected_asset_id) { const sk = assetKind(g.selected_asset_id); if (sk) byKind[sk] = g.selected_asset_id; }
  if (existing) { // don't clobber an already-populated map (idempotent)
    skipped++; continue;
  }
  if (!Object.keys(byKind).length) { skipped++; continue; }
  planned++;
  const kinds = Object.entries(byKind).map(([k, v]) => `${k}=${v.slice(0,8)}`).join(', ');
  console.log(`${APPLY ? 'WRITE' : 'PLAN'} ${g.canvas_id.slice(0,8)}/${g.node_id} -> {${kinds}}  (was selected_asset_id=${(g.selected_asset_id||'').slice(0,8)})`);
  if (APPLY) update.run(JSON.stringify(byKind), g.id);
}

console.log(`\n${APPLY ? 'APPLIED' : 'DRY RUN'}: ${planned} groups ${APPLY ? 'updated' : 'to update'}, ${skipped} skipped (already set or no assets). Total groups: ${groups.length}`);
if (!APPLY) console.log('Re-run with --apply to back up and write.');
