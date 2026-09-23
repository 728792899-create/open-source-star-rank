import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const config=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
assert.equal(config.name,'open-source-star-rank-operations');
assert.equal(config.d1_databases[0].binding,'STATE_DB');
assert.equal(config.d1_databases[0].database_name,'open-source-star-rank-operations');
assert.equal(config.vars.BACKUP_MODE,'disabled');
assert.equal(config.r2_buckets,undefined);
assert.match(readFileSync(new URL('../migrations/0001_operations_state.sql',import.meta.url),'utf8'),/CREATE TABLE IF NOT EXISTS operations_state/);
assert.equal(config.vars.AUTO_RECOVERY,'false');
assert.equal(config.vars.ISSUE_ALERTS,'false');
assert.deepEqual(config.triggers.crons,['*/15 * * * *']);
assert.match(config.vars.SITE_INDEX,/^https:\/\//);
console.log('Operations configuration valid; recovery and issue delivery require explicit activation.');
const lock=JSON.parse(readFileSync(new URL('../package-lock.json',import.meta.url),'utf8'));
assert.equal(lock.version,'1.0.0');
for(const [path,entry] of Object.entries(lock.packages)) {
 assert.ok(path==='' || path.startsWith('node_modules/'),'Lockfile contains a checkout-specific path: '+path);
 assert.notEqual(entry.link,true,'Lockfile contains a local dependency link: '+path);
 if(entry.os || entry.cpu)assert.equal(entry.optional,true,'Platform-specific binary must be optional: '+path);
}
assert.ok(lock.packages['node_modules/@cloudflare/workerd-linux-64'],'Linux runtime must be locked for CI');
console.log('Dependency lock is portable across development and Linux CI.');
