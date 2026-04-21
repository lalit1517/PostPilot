#!/usr/bin/env node
// Provisions Grafana data source and imports all dashboards.
// Usage: node grafana/provision.js
// Env required: GRAFANA_URL, GRAFANA_API_KEY, DATABASE_URL

import { readFileSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function requireEnv(name) {
  const val = process.env[name];
  if (!val) { console.error(`❌ Missing required env var: ${name}`); process.exit(1); }
  return val;
}

function parseDbUrl(url) {
  // Manual parse to handle passwords containing '@'
  // Format: postgresql://user:password@host:port/database
  const withoutScheme = url.replace(/^postgresql:\/\/|^postgres:\/\//, '');
  // Split on last '@' before the host (host always contains a dot)
  const atIndex = withoutScheme.lastIndexOf('@');
  const userInfo = withoutScheme.slice(0, atIndex);
  const hostAndDb = withoutScheme.slice(atIndex + 1);
  const colonInUser = userInfo.indexOf(':');
  const user = decodeURIComponent(userInfo.slice(0, colonInUser));
  const password = decodeURIComponent(userInfo.slice(colonInUser + 1));
  const slashIndex = hostAndDb.indexOf('/');
  const hostPort = hostAndDb.slice(0, slashIndex);
  const database = hostAndDb.slice(slashIndex + 1).split('?')[0]; // Strip query params
  const [hostname, port] = hostPort.split(':');
  return {
    host: `${hostname}:${port || '5432'}`,
    database,
    user,
    password,
  };
}

// Load .env if present (simple parser, no dep on dotenv)
try {
  const envPath = resolve(__dirname, '../.env');
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
} catch {
  // .env not found — rely on shell env
}

const GRAFANA_URL = requireEnv('GRAFANA_URL').replace(/\/$/, '');
const GRAFANA_API_KEY = requireEnv('GRAFANA_API_KEY');
const DATABASE_URL = process.env.GRAFANA_DATABASE_URL || requireEnv('DATABASE_URL');

const db = parseDbUrl(DATABASE_URL);

const headers = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${GRAFANA_API_KEY}`,
};

async function grafanaFetch(path, method, body) {
  const res = await fetch(`${GRAFANA_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { message: text }; }
  return { status: res.status, json };
}

async function provisionDatasource() {
  const template = JSON.parse(
    readFileSync(resolve(__dirname, 'provisioning/datasource.json'), 'utf8')
  );
  const ds = {
    ...template,
    url: db.host, // Ensure top-level URL is also updated
    database: db.database,
    user: db.user,
    jsonData: { 
      ...template.jsonData, 
      host: db.host, 
      database: db.database 
    },
    secureJsonData: { password: db.password },
  };

  const { status, json: existing } = await grafanaFetch(
    `/api/datasources/name/${encodeURIComponent(ds.name)}`, 'GET'
  );
  if (status === 200) {
    // Delete and recreate — Grafana Cloud PUT is strict about payload shape
    const { status: delStatus } = await grafanaFetch(`/api/datasources/${existing.id}`, 'DELETE');
    if (delStatus !== 200) {
      console.error('❌ Failed to delete existing data source');
      process.exit(1);
    }
    console.log(`🗑️  Deleted existing data source (id: ${existing.id})`);
  }

  const { status: createStatus, json } = await grafanaFetch('/api/datasources', 'POST', ds);
  if (createStatus !== 200 && createStatus !== 201) {
    console.error('❌ Failed to create data source:', JSON.stringify(json, null, 2));
    process.exit(1);
  }
  console.log(`✅ Data source created (uid: ${json.datasource?.uid ?? json.uid})`);
}

async function getDatasourceUid() {
  const { status, json } = await grafanaFetch(
    `/api/datasources/name/${encodeURIComponent('PostPilot Supabase')}`, 'GET'
  );
  if (status !== 200) {
    console.error('❌ Could not fetch data source uid:', JSON.stringify(json, null, 2));
    process.exit(1);
  }
  return json.uid;
}

function injectDatasource(dashboard, uid) {
  if (!dashboard.panels) return;
  for (const panel of dashboard.panels) {
    if (panel.datasource !== undefined) {
      panel.datasource = { type: 'grafana-postgresql-datasource', uid };
    }
    if (Array.isArray(panel.targets)) {
      for (const t of panel.targets) {
        if (t.datasource !== undefined) {
          t.datasource = { type: 'grafana-postgresql-datasource', uid };
        }
      }
    }
    // Handle nested panels inside rows
    if (Array.isArray(panel.panels)) injectDatasource(panel, uid);
  }
}

async function importDashboards(dsUid) {
  const dashboardsDir = resolve(__dirname, 'dashboards');
  const files = readdirSync(dashboardsDir).filter(f => f.endsWith('.json'));

  for (const file of files) {
    const raw = JSON.parse(
      readFileSync(resolve(dashboardsDir, file), 'utf8')
    );
    injectDatasource(raw, dsUid);

    const payload = { dashboard: { ...raw, id: null }, overwrite: true, folderId: 0 };
    const { status, json } = await grafanaFetch('/api/dashboards/db', 'POST', payload);
    if (status !== 200) {
      console.error(`❌ Failed to import ${file}:`, JSON.stringify(json, null, 2));
      process.exit(1);
    }
    console.log(`✅ Imported: ${file} → ${GRAFANA_URL}${json.url}`);
  }
}

async function main() {
  console.log('🚀 PostPilot Grafana Provisioner\n');
  await provisionDatasource();
  const dsUid = await getDatasourceUid();
  await importDashboards(dsUid);
  console.log(`\n✅ Provisioning complete.\n   Dashboards: ${GRAFANA_URL}/dashboards`);
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
