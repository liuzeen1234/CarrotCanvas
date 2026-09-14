const DB=require('../../backend/node_modules/better-sqlite3');
const assert=require('node:assert/strict');const fs=require('node:fs');const crypto=require('node:crypto');
const old=new DB('backend/data/project-io-before-1789350307028.sqlite',{readonly:true});const live=new DB('backend/data/carrot-canvas.sqlite',{readonly:true});
const tables=old.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t=>t.name).filter(n=>/canvas|generation|asset/.test(n));
const report={checkedAt:new Date().toISOString(),tables:{}};
for(const table of tables){if(table==='canvas_control_leases'||table==='canvas_asset_gc_jobs')continue;const cols=old.prepare(`PRAGMA table_info("${table}")`).all().map(c=>c.name);const rows=old.prepare(`SELECT * FROM "${table}"`).all();let checked=0;for(const row of rows){if(!row.id)continue;const current=live.prepare(`SELECT * FROM "${table}" WHERE id=?`).get(row.id);assert(current,`Missing legacy ${table} record`);for(const col of cols)assert.deepEqual(current[col],row[col],`Changed legacy ${table}.${col}`);checked++;}report.tables[table]=checked;}
report.remainingTestCanvases=live.prepare("SELECT count(*) AS n FROM canvas_docs WHERE name LIKE '验收 · %'").get().n;
const assets=old.prepare('SELECT * FROM assets').all();let existingFiles=0;for(const asset of assets){const path=require('node:path').join('backend/data/assets',asset.canvas_id,asset.rel_path);if(fs.existsSync(path))existingFiles++;}
report.legacyAssetFilesPresent=existingFiles;report.legacyAssetRows=assets.length;
fs.writeFileSync('artifacts/projects-io/legacy-compatibility.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
