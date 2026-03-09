const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const TOOLS_PATH = path.join(__dirname, '..', 'tools.json');
const NOTIFICATIONS_PATH = path.join(__dirname, 'notifications.json');
const TODAY = new Date().toISOString().split('T')[0];
const SIX_MONTHS_MS = 6 * 30 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10000;
const MAX_REDIRECTS = 3;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

function log(icon, message) {
  console.log(`${icon} ${message}`);
}

function httpGet(url, redirectCount = 0) {
  return new Promise((resolve) => {
    if (redirectCount > MAX_REDIRECTS) {
      resolve({ ok: false, status: 0, error: 'too many redirects' });
      return;
    }

    const client = url.startsWith('https') ? https : http;
    const request = client.get(url, { timeout: REQUEST_TIMEOUT_MS }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).toString();
        resolve(httpGet(redirectUrl, redirectCount + 1));
        return;
      }

      res.resume();
      resolve({
        ok: res.statusCode >= 200 && res.statusCode < 400,
        status: res.statusCode,
      });
    });

    request.on('timeout', () => {
      request.destroy();
      resolve({ ok: false, status: 0, error: 'timeout' });
    });

    request.on('error', (err) => {
      resolve({ ok: false, status: 0, error: err.message });
    });
  });
}

function githubApiGet(endpoint) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.github.com',
      path: endpoint,
      headers: {
        'User-Agent': 'nopulse-bot',
        'Accept': 'application/vnd.github.v3+json',
      },
      timeout: REQUEST_TIMEOUT_MS,
    };

    if (GITHUB_TOKEN) {
      options.headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
    }

    const request = https.get(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    });

    request.on('timeout', () => {
      request.destroy();
      resolve(null);
    });

    request.on('error', () => resolve(null));
  });
}

async function checkGithubActivity(repoSlug) {
  const data = await githubApiGet(`/repos/${repoSlug}`);
  if (!data || !data.pushed_at) return null;

  const lastPush = new Date(data.pushed_at);
  const msSinceLastPush = Date.now() - lastPush.getTime();
  const isStale = msSinceLastPush > SIX_MONTHS_MS;

  return {
    lastPush: data.pushed_at.split('T')[0],
    isStale,
    daysSinceLastPush: Math.floor(msSinceLastPush / (1000 * 60 * 60 * 24)),
  };
}

async function checkTool(tool) {
  const changes = [];

  if (tool.status === 'dead') {
    log('  [SKULL]', `${tool.name} — already dead. rest in peace.`);
    tool.last_checked = TODAY;
    return { tool, changes, needsNotification: false };
  }

  log('  [PULSE]', `checking pulse for ${tool.name}...`);

  let webAlive = false;
  if (tool.url) {
    const response = await httpGet(tool.url);
    webAlive = response.ok;
    if (webAlive) {
      log('  [HEARTBEAT]', `${tool.name} — heartbeat detected (${response.status})`);
    } else {
      log('  [FLATLINE]', `${tool.name} — no heartbeat (${response.error || response.status})`);
    }
  } else {
    log('  [SHRUG]', `${tool.name} — no URL on file. can't check what doesn't exist.`);
  }

  let githubInfo = null;
  if (tool.github) {
    githubInfo = await checkGithubActivity(tool.github);
    if (githubInfo) {
      log('  [REPO]', `${tool.name} — last commit ${githubInfo.daysSinceLastPush} days ago${githubInfo.isStale ? ' (stale)' : ''}`);
    }
  }

  const previousStatus = tool.status;
  let needsNotification = false;

  if (webAlive) {
    if (tool.strikes > 0) {
      changes.push(`strikes reset from ${tool.strikes} to 0`);
    }
    tool.strikes = 0;
    tool.status = 'alive';
    tool.last_confirmed = TODAY;
  } else if (tool.url) {
    tool.strikes += 1;

    if (tool.strikes === 1) {
      tool.status = 'warning';
      changes.push('strike 1 — status: warning');
      log('  [WARNING]', `${tool.name} — strike 1. the clock is ticking.`);
    } else if (tool.strikes === 2) {
      tool.status = 'warning';
      changes.push('strike 2 — notification sent');
      needsNotification = true;
      log('  [SIREN]', `${tool.name} — strike 2. sending last rites notification.`);
    } else if (tool.strikes >= 3) {
      tool.status = 'dead';
      tool.died_at = TODAY;
      changes.push('strike 3 — declared dead');
      log('  [TOMBSTONE]', `${tool.name} — time of death: ${TODAY}. another one bites the dust.`);
    }
  }

  if (previousStatus !== tool.status) {
    changes.push(`status: ${previousStatus} -> ${tool.status}`);
  }

  tool.last_checked = TODAY;

  return { tool, changes, needsNotification };
}

async function main() {
  log('[MONITOR]', `nopulse.dev — pulse check ${TODAY}`);
  log('[MONITOR]', '=========================================\n');

  const data = JSON.parse(fs.readFileSync(TOOLS_PATH, 'utf8'));
  const notifications = [];
  const summaryChanges = [];

  for (const tool of data.tools) {
    const result = await checkTool(tool);

    if (result.changes.length > 0) {
      summaryChanges.push({ name: tool.name, changes: result.changes });
    }

    if (result.needsNotification && tool.contact) {
      notifications.push({
        name: tool.name,
        url: tool.url,
        contact: tool.contact,
      });
    }
  }

  fs.writeFileSync(TOOLS_PATH, JSON.stringify(data, null, 2) + '\n');
  fs.writeFileSync(NOTIFICATIONS_PATH, JSON.stringify(notifications, null, 2) + '\n');

  log('\n[MONITOR]', '=========================================');
  log('[MONITOR]', 'SUMMARY\n');

  const alive = data.tools.filter((t) => t.status === 'alive').length;
  const warning = data.tools.filter((t) => t.status === 'warning').length;
  const dead = data.tools.filter((t) => t.status === 'dead').length;

  log('[STATS]', `alive: ${alive} | warning: ${warning} | dead: ${dead}`);

  if (summaryChanges.length === 0) {
    log('[STATS]', 'no status changes this week. boring.');
  } else {
    log('[STATS]', `${summaryChanges.length} status change(s):`);
    for (const entry of summaryChanges) {
      for (const change of entry.changes) {
        log('  ->', `${entry.name}: ${change}`);
      }
    }
  }

  if (notifications.length > 0) {
    log('\n[EMAIL]', `${notifications.length} notification(s) queued.`);
  }

  log('\n[MONITOR]', 'pulse check complete. see you next week.');
}

main().catch((err) => {
  console.error('pulse check failed:', err);
  process.exit(1);
});
