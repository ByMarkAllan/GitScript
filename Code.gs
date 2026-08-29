/**
 * GitScript — Google Apps Script → GitHub Cloud Sync
 * Backend v1.2
 *
 * Required Script Properties:
 *   GITHUB_TOKEN            GitHub fine-grained/classic token with the repo permissions GitScript needs.
 *
 * Optional Script Properties:
 *   GITHUB_OWNER            Default owner/org used by Create Repository. If omitted, authenticated user is used.
 *   CONFIG_SPREADSHEET_ID   Configuration spreadsheet. Created automatically when omitted.
 *   SCHEDULE_TIMEZONE       IANA timezone for scheduled syncs. Defaults to the Apps Script project timezone.
 *
 * Important:
 * - Keep GITHUB_TOKEN server-side in Script Properties only.
 * - Associate this Apps Script project with a standard Google Cloud project.
 * - Enable the Google Apps Script API in that Cloud project.
 * - Turn on Apps Script API access in the Apps Script account settings.
 * - Deploy the web app as an identity that can read every mapped Apps Script project.
 * - Time-based scheduling uses ONE 15-minute dispatcher trigger for all active scheduled integrations.
 * - Supported schedules: recurring intervals, daily at an hour, or weekly on a chosen weekday + hour.
 */

const APP = Object.freeze({
  NAME: 'GitScript',
  SHEET_NAME: 'Sync Configurations',
  GITHUB_API: 'https://api.github.com',
  SCRIPT_API: 'https://script.googleapis.com/v1',
  SCHEDULER_HANDLER: 'runScheduledSyncs',
  SCHEDULER_INTERVAL_MINUTES: 15,
  ALLOWED_INTERVAL_HOURS: [1, 2, 4, 6, 12, 24],
  WEEKDAYS: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  LIFECYCLES: ['active', 'inactive', 'archived'],
  HEADERS: [
    'ID',
    'Nickname',
    'Script ID',
    'Repository',
    'Branch',
    'Created At',
    'Last Push',
    'Sync Status',
    'Lifecycle',
    'Last Error',
    'Schedule Enabled',
    'Schedule Type',
    'Schedule Interval Hours',
    'Schedule Hour',
    'Schedule Weekday',
    'Schedule Timezone',
    'Next Scheduled Sync',
    'Last Scheduled Sync',
    'Archived At'
  ]
});

/* ========================================================================== */
/* WEB APP                                                                    */
/* ========================================================================== */

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle(APP.NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function getConnectedProfileEmail() {
  return Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail() || '';
}

/* ========================================================================== */
/* GITHUB                                                                     */
/* ========================================================================== */

function getGitHubRepositories() {
  const repos = githubRequest_('/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member', {
    method: 'get'
  });

  return (repos || [])
    .filter(repo => repo && repo.permissions && repo.permissions.push)
    .map(repo => ({
      id: repo.id,
      name: repo.name,
      fullName: repo.full_name,
      private: Boolean(repo.private),
      defaultBranch: repo.default_branch || 'main'
    }));
}

function createGitHubRepository(input) {
  const payload = input || {};
  const name = String(payload.name || '').trim();
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error('Invalid repository name. Use letters, numbers, periods, underscores, or hyphens only.');
  }

  const props = PropertiesService.getScriptProperties();
  const owner = String(props.getProperty('GITHUB_OWNER') || '').trim();
  const authUser = githubRequest_('/user', { method: 'get' });
  const isOrgTarget = owner && authUser && owner.toLowerCase() !== String(authUser.login || '').toLowerCase();
  const endpoint = isOrgTarget ? '/orgs/' + encodeURIComponent(owner) + '/repos' : '/user/repos';

  const repo = githubRequest_(endpoint, {
    method: 'post',
    payload: {
      name: name,
      private: Boolean(payload.private),
      auto_init: true,
      description: 'Source mirror managed by GitScript.'
    }
  });

  return {
    id: repo.id,
    name: repo.name,
    fullName: repo.full_name,
    private: Boolean(repo.private),
    defaultBranch: repo.default_branch || 'main'
  };
}

/* ========================================================================== */
/* CONFIGURATION                                                              */
/* ========================================================================== */

/**
 * Returns active, inactive, and archived integrations.
 * The frontend can group/filter them without making separate requests.
 */
function getSyncConfigurations() {
  return listConfigurations_().map(toPublicConfiguration_).reverse();
}

function saveSyncConfiguration(input) {
  const data = input || {};
  const nickname = String(data.nickname || '').trim();
  const scriptId = normalizeScriptId_(data.scriptId || data.gasProjectLink);
  const repository = String(data.repository || '').trim();
  const branch = normalizeBranch_(data.branch || 'main');

  if (!nickname) throw new Error('Project nickname is required.');
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('Select a valid GitHub repository.');
  }

  // Fail early with an actionable Apps Script error instead of waiting for first sync.
  validateAppsScriptProjectAccess_(scriptId);

  // Verify GitHub access before persisting the route.
  githubRequest_('/repos/' + repository, { method: 'get' });

  const existing = listConfigurations_().find(item =>
    item.lifecycle !== 'archived' &&
    item.scriptId === scriptId &&
    item.repository.toLowerCase() === repository.toLowerCase() &&
    item.branch === branch
  );
  if (existing) {
    throw new Error('This Apps Script project is already mapped to the selected repository and branch.');
  }

  const createdAt = new Date();
  const id = Utilities.getUuid();
  const sheet = getConfigSheet_();
  const headers = getHeaders_(sheet);

  appendObjectRow_(sheet, headers, {
    'ID': id,
    'Nickname': nickname,
    'Script ID': scriptId,
    'Repository': repository,
    'Branch': branch,
    'Created At': createdAt,
    'Last Push': '',
    'Sync Status': 'ready',
    'Lifecycle': 'active',
    'Last Error': '',
    'Schedule Enabled': false,
    'Schedule Type': 'manual',
    'Schedule Interval Hours': '',
    'Schedule Hour': '',
    'Schedule Weekday': '',
    'Schedule Timezone': getScheduleTimeZone_(),
    'Next Scheduled Sync': '',
    'Last Scheduled Sync': '',
    'Archived At': ''
  });

  const config = findConfiguration_(id);
  return toPublicConfiguration_(config);
}

function deactivateIntegration(configurationId) {
  return setIntegrationLifecycle_(configurationId, 'inactive');
}

function reactivateIntegration(configurationId) {
  return setIntegrationLifecycle_(configurationId, 'active');
}

function archiveIntegration(configurationId) {
  return setIntegrationLifecycle_(configurationId, 'archived');
}

/** Alias used by the UI for archived records. */
function restoreIntegration(configurationId) {
  return setIntegrationLifecycle_(configurationId, 'active');
}

function setIntegrationLifecycle_(configurationId, lifecycle) {
  const desired = String(lifecycle || '').toLowerCase();
  if (APP.LIFECYCLES.indexOf(desired) === -1) throw new Error('Invalid integration lifecycle.');

  const config = requireConfiguration_(configurationId);
  const sheet = getConfigSheet_();
  const map = getHeaderMap_(sheet);

  sheet.getRange(config.row, map['Lifecycle']).setValue(desired);

  if (desired === 'archived') {
    sheet.getRange(config.row, map['Archived At']).setValue(new Date());
  } else {
    sheet.getRange(config.row, map['Archived At']).clearContent();
  }

  // A lifecycle change can make the shared scheduler necessary or unnecessary.
  reconcileSchedulerTrigger_();

  return toPublicConfiguration_(requireConfiguration_(configurationId));
}

/* ========================================================================== */
/* SCHEDULING                                                                 */
/* ========================================================================== */

/**
 * Returns scheduler metadata for the schedule modal / diagnostics UI.
 */
function getSchedulerInfo() {
  const triggers = getSchedulerTriggers_();
  return {
    timezone: getScheduleTimeZone_(),
    dispatcherMinutes: APP.SCHEDULER_INTERVAL_MINUTES,
    allowedIntervalHours: APP.ALLOWED_INTERVAL_HOURS.slice(),
    weekdays: APP.WEEKDAYS.map((name, value) => ({ value: value, name: name })),
    triggerActive: triggers.length > 0,
    triggerCount: triggers.length
  };
}

/**
 * input examples:
 *   { enabled: false }
 *   { enabled: true, type: 'interval', intervalHours: 4 }
 *   { enabled: true, type: 'daily', hour: 8 }
 *   { enabled: true, type: 'weekly', weekday: 1, hour: 8 } // Monday at 8 AM
 */
function setIntegrationSchedule(configurationId, input) {
  const config = requireConfiguration_(configurationId);
  if (config.lifecycle === 'archived') {
    throw new Error('Restore this integration before changing its schedule.');
  }

  const data = input || {};
  const enabled = toBoolean_(data.enabled);
  const timezone = getScheduleTimeZone_();
  const sheet = getConfigSheet_();
  const map = getHeaderMap_(sheet);

  if (!enabled) {
    setRowValuesByHeader_(sheet, config.row, map, {
      'Schedule Enabled': false,
      'Schedule Type': 'manual',
      'Schedule Interval Hours': '',
      'Schedule Hour': '',
      'Schedule Weekday': '',
      'Schedule Timezone': timezone,
      'Next Scheduled Sync': ''
    });
    reconcileSchedulerTrigger_();
    return toPublicConfiguration_(requireConfiguration_(configurationId));
  }

  const type = String(data.type || '').toLowerCase();
  if (['interval', 'daily', 'weekly'].indexOf(type) === -1) {
    throw new Error('Choose an interval, daily, or weekly schedule.');
  }

  let intervalHours = '';
  let hour = '';
  let weekday = '';

  if (type === 'interval') {
    intervalHours = Number(data.intervalHours);
    if (APP.ALLOWED_INTERVAL_HOURS.indexOf(intervalHours) === -1) {
      throw new Error('Unsupported interval. Choose 1, 2, 4, 6, 12, or 24 hours.');
    }
  }

  if (type === 'daily' || type === 'weekly') {
    hour = Number(data.hour);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      throw new Error('Schedule hour must be between 0 and 23.');
    }
  }

  if (type === 'weekly') {
    weekday = Number(data.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      throw new Error('Choose a valid day of the week.');
    }
  }

  const schedule = {
    enabled: true,
    type: type,
    intervalHours: intervalHours,
    hour: hour,
    weekday: weekday,
    timezone: timezone
  };
  const nextRun = computeNextScheduledRun_(schedule, new Date());

  setRowValuesByHeader_(sheet, config.row, map, {
    'Schedule Enabled': true,
    'Schedule Type': type,
    'Schedule Interval Hours': intervalHours,
    'Schedule Hour': hour,
    'Schedule Weekday': weekday,
    'Schedule Timezone': timezone,
    'Next Scheduled Sync': nextRun
  });

  reconcileSchedulerTrigger_();
  return toPublicConfiguration_(requireConfiguration_(configurationId));
}

function clearIntegrationSchedule(configurationId) {
  return setIntegrationSchedule(configurationId, { enabled: false });
}

/**
 * Installable time-based trigger handler.
 * One dispatcher evaluates every active scheduled integration.
 */
function runScheduledSyncs() {
  const now = new Date();
  const due = listConfigurations_().filter(config => {
    if (config.lifecycle !== 'active') return false;
    if (!config.schedule.enabled) return false;
    if (!config.schedule.nextRun) return true;
    const next = new Date(config.schedule.nextRun);
    return !isNaN(next.getTime()) && next.getTime() <= now.getTime();
  });

  const results = [];

  due.forEach(config => {
    let ok = false;
    let message = '';
    try {
      const result = syncConfiguration_(config.id, 'scheduled');
      ok = true;
      message = 'Synced ' + (result.commitSha ? result.commitSha.substring(0, 7) : 'successfully');
    } catch (error) {
      message = error && error.message ? error.message : String(error);
      console.error('Scheduled sync failed for ' + config.nickname + ': ' + message);
    } finally {
      const latest = requireConfiguration_(config.id);
      const sheet = getConfigSheet_();
      const map = getHeaderMap_(sheet);
      const nextRun = computeNextScheduledRun_(latest.schedule, new Date());
      setRowValuesByHeader_(sheet, latest.row, map, {
        'Last Scheduled Sync': new Date(),
        'Next Scheduled Sync': nextRun || ''
      });
    }

    results.push({
      id: config.id,
      nickname: config.nickname,
      ok: ok,
      message: message
    });
  });

  reconcileSchedulerTrigger_();
  return {
    checkedAt: now.toISOString(),
    dueCount: due.length,
    results: results
  };
}

function reconcileSchedulerTrigger_() {
  const needsTrigger = listConfigurations_().some(config =>
    config.lifecycle === 'active' && config.schedule.enabled
  );

  const triggers = getSchedulerTriggers_();

  if (needsTrigger && triggers.length === 0) {
    ScriptApp.newTrigger(APP.SCHEDULER_HANDLER)
      .timeBased()
      .everyMinutes(APP.SCHEDULER_INTERVAL_MINUTES)
      .create();
    return;
  }

  if (!needsTrigger) {
    triggers.forEach(trigger => ScriptApp.deleteTrigger(trigger));
    return;
  }

  // Defensive cleanup if a prior deployment created duplicates.
  if (triggers.length > 1) {
    triggers.slice(1).forEach(trigger => ScriptApp.deleteTrigger(trigger));
  }
}

function getSchedulerTriggers_() {
  return ScriptApp.getProjectTriggers().filter(trigger =>
    trigger.getHandlerFunction() === APP.SCHEDULER_HANDLER
  );
}

function computeNextScheduledRun_(schedule, fromDate) {
  if (!schedule || !schedule.enabled) return null;
  const now = fromDate instanceof Date ? fromDate : new Date(fromDate || Date.now());

  if (schedule.type === 'interval') {
    const hours = Number(schedule.intervalHours);
    if (APP.ALLOWED_INTERVAL_HOURS.indexOf(hours) === -1) return null;
    return new Date(now.getTime() + hours * 60 * 60 * 1000);
  }

  if (schedule.type === 'daily') {
    const hour = Number(schedule.hour);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;

    const timezone = schedule.timezone || getScheduleTimeZone_();
    const parts = getLocalDateParts_(now, timezone);
    let target = dateFromLocalParts_(parts.year, parts.month, parts.day, hour, 0, timezone);

    if (target.getTime() <= now.getTime() + 60 * 1000) {
      const tomorrow = addLocalDays_(parts.year, parts.month, parts.day, 1);
      target = dateFromLocalParts_(tomorrow.year, tomorrow.month, tomorrow.day, hour, 0, timezone);
    }
    return target;
  }

  if (schedule.type === 'weekly') {
    const hour = Number(schedule.hour);
    const weekday = Number(schedule.weekday);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return null;

    const timezone = schedule.timezone || getScheduleTimeZone_();
    const parts = getLocalDateParts_(now, timezone);
    const currentWeekday = getWeekdayForLocalDate_(parts.year, parts.month, parts.day);

    let daysAhead = (weekday - currentWeekday + 7) % 7;
    let targetParts = addLocalDays_(parts.year, parts.month, parts.day, daysAhead);
    let target = dateFromLocalParts_(targetParts.year, targetParts.month, targetParts.day, hour, 0, timezone);

    if (daysAhead === 0 && target.getTime() <= now.getTime() + 60 * 1000) {
      targetParts = addLocalDays_(parts.year, parts.month, parts.day, 7);
      target = dateFromLocalParts_(targetParts.year, targetParts.month, targetParts.day, hour, 0, timezone);
    }

    return target;
  }

  return null;
}

function getScheduleTimeZone_() {
  const configured = String(PropertiesService.getScriptProperties().getProperty('SCHEDULE_TIMEZONE') || '').trim();
  const fallback = Session.getScriptTimeZone() || 'Etc/UTC';
  const timezone = configured || fallback;

  try {
    Utilities.formatDate(new Date(), timezone, 'yyyy-MM-dd HH:mm');
    return timezone;
  } catch (_) {
    return fallback;
  }
}

function getLocalDateParts_(date, timezone) {
  const value = Utilities.formatDate(date, timezone, 'yyyy-MM-dd-HH-mm');
  const p = value.split('-').map(Number);
  return { year: p[0], month: p[1], day: p[2], hour: p[3], minute: p[4] };
}

function addLocalDays_(year, month, day, amount) {
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + amount);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate()
  };
}

/**
 * Returns JavaScript weekday numbering for a local calendar date:
 * 0 = Sunday ... 6 = Saturday.
 */
function getWeekdayForLocalDate_(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Converts a local wall-clock time in an IANA timezone to a real Date. */
function dateFromLocalParts_(year, month, day, hour, minute, timezone) {
  const utcWallClock = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let candidate = new Date(utcWallClock);

  // Two iterations handle most DST offset boundaries correctly.
  for (let i = 0; i < 2; i++) {
    const offsetMinutes = parseTimezoneOffsetMinutes_(Utilities.formatDate(candidate, timezone, 'Z'));
    candidate = new Date(utcWallClock - offsetMinutes * 60 * 1000);
  }
  return candidate;
}

function parseTimezoneOffsetMinutes_(value) {
  const text = String(value || '+0000');
  const match = text.match(/^([+-])(\d{2})(\d{2})$/);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

/* ========================================================================== */
/* SYNC                                                                       */
/* ========================================================================== */

function syncNow(configurationId) {
  return syncConfiguration_(configurationId, 'manual');
}

function syncConfiguration_(configurationId, source) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1500)) {
    throw new Error('Another sync is currently running. Try again shortly.');
  }

  try {
    const config = requireConfiguration_(configurationId);
    if (config.lifecycle === 'inactive') {
      throw new Error('This integration is inactive. Reactivate it before syncing.');
    }
    if (config.lifecycle === 'archived') {
      throw new Error('This integration is archived. Restore it before syncing.');
    }

    const logs = [];
    logs.push(source === 'scheduled' ? 'Scheduled sync started…' : 'Fetching Apps Script source…');

    const files = getAppsScriptProjectContent_(config.scriptId);
    if (!files.length) throw new Error('No Apps Script project files were returned.');
    logs.push(files.length + ' source files indexed');

    const repoParts = config.repository.split('/');
    const owner = repoParts[0];
    const repo = repoParts[1];
    const branch = config.branch || 'main';

    logs.push('Resolving GitHub branch…');
    const headSha = ensureBranch_(owner, repo, branch);
    const baseCommit = githubRequest_('/repos/' + owner + '/' + repo + '/git/commits/' + headSha, { method: 'get' });
    const baseTreeSha = baseCommit.tree.sha;

    logs.push('Creating Git blobs…');
    const treeEntries = files.map(file => {
      const blob = githubRequest_('/repos/' + owner + '/' + repo + '/git/blobs', {
        method: 'post',
        payload: {
          content: String(file.source || ''),
          encoding: 'utf-8'
        }
      });
      return {
        path: toGitHubFileName_(file),
        mode: '100644',
        type: 'blob',
        sha: blob.sha
      };
    });

    logs.push('Building source tree…');
    const tree = githubRequest_('/repos/' + owner + '/' + repo + '/git/trees', {
      method: 'post',
      payload: {
        base_tree: baseTreeSha,
        tree: treeEntries
      }
    });

    const commit = githubRequest_('/repos/' + owner + '/' + repo + '/git/commits', {
      method: 'post',
      payload: {
        message: source === 'scheduled'
          ? 'Scheduled Apps Script sync via GitScript'
          : 'Sync Apps Script source via GitScript',
        tree: tree.sha,
        parents: [headSha]
      }
    });

    logs.push('Publishing commit to ' + branch + '…');
    githubRequest_('/repos/' + owner + '/' + repo + '/git/refs/heads/' + encodeURIComponent(branch), {
      method: 'patch',
      payload: { sha: commit.sha, force: false }
    });

    const now = new Date();
    updateSyncState_(config.row, {
      lastPush: now,
      syncStatus: 'ready',
      lastError: ''
    });
    logs.push('Sync completed · ' + commit.sha.substring(0, 7));

    return {
      ok: true,
      source: source,
      lastPush: now.toISOString(),
      commitSha: commit.sha,
      commitUrl: 'https://github.com/' + owner + '/' + repo + '/commit/' + commit.sha,
      logs: logs
    };
  } catch (error) {
    try {
      const config = findConfiguration_(configurationId);
      if (config) {
        updateSyncState_(config.row, {
          syncStatus: 'error',
          lastError: error && error.message ? error.message : String(error)
        });
      }
    } catch (_) {}
    throw error;
  } finally {
    lock.releaseLock();
  }
}

/* ========================================================================== */
/* APPS SCRIPT API                                                            */
/* ========================================================================== */

function validateAppsScriptProjectAccess_(scriptId) {
  const files = getAppsScriptProjectContent_(scriptId);
  if (!Array.isArray(files)) throw new Error('Unable to validate the Apps Script project.');
  return true;
}

function getAppsScriptProjectContent_(scriptId) {
  const normalized = normalizeScriptId_(scriptId);
  const token = ScriptApp.getOAuthToken();
  const url = APP.SCRIPT_API + '/projects/' + encodeURIComponent(normalized) + '/content';
  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  const body = response.getContentText();

  if (code < 200 || code >= 300) {
    let message = extractApiMessage_(body);

    if (code === 400) {
      message += ' Confirm that you copied Project Settings → Script ID, not a Web App deployment URL or AKfy… deployment ID.';
    } else if (code === 403) {
      message += ' Confirm that the Apps Script API is enabled for GitScript’s standard Google Cloud project and that this Google account has access to the target script.';
    } else if (code === 404) {
      message += ' Confirm that the Script ID exists and that the signed-in Google account can access the project.';
    }

    throw new Error('Apps Script API error (' + code + '): ' + message);
  }

  const parsed = JSON.parse(body || '{}');
  return Array.isArray(parsed.files) ? parsed.files : [];
}

/**
 * Accepts:
 * - https://script.google.com/home/projects/SCRIPT_ID/edit
 * - https://script.google.com/u/0/home/projects/SCRIPT_ID/edit
 * - https://script.google.com/d/SCRIPT_ID/edit
 * - raw Script ID
 *
 * Explicitly rejects Web App deployment URLs and AKfy… deployment IDs.
 */
function normalizeScriptId_(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('Apps Script editor URL or Script ID is required.');

  if (/script\.google\.com\/macros\/s\//i.test(text) || /^AKfy/i.test(text)) {
    throw new Error(
      'A Web App deployment ID was detected. GitScript needs the project Script ID. ' +
      'Open the target Apps Script project → Project Settings → Script ID → Copy.'
    );
  }

  const homeMatch = text.match(/script\.google\.com\/(?:u\/\d+\/)?home\/projects\/([A-Za-z0-9_-]{20,})/i);
  if (homeMatch) return homeMatch[1];

  const editorMatch = text.match(/script\.google\.com\/d\/([A-Za-z0-9_-]{20,})/i);
  if (editorMatch) return editorMatch[1];

  if (/^[A-Za-z0-9_-]{20,}$/.test(text)) return text;

  throw new Error(
    'Invalid Apps Script project identifier. Paste the Apps Script editor URL or Project Settings → Script ID.'
  );
}

/* ========================================================================== */
/* GITHUB HELPERS                                                             */
/* ========================================================================== */

function ensureBranch_(owner, repo, branch) {
  const path = '/repos/' + owner + '/' + repo + '/git/ref/heads/' + encodeURIComponent(branch);
  try {
    const ref = githubRequest_(path, { method: 'get' });
    return ref.object.sha;
  } catch (err) {
    if (!String(err.message || '').includes('(404)')) throw err;
  }

  const repoInfo = githubRequest_('/repos/' + owner + '/' + repo, { method: 'get' });
  const defaultBranch = repoInfo.default_branch || 'main';
  const defaultRef = githubRequest_(
    '/repos/' + owner + '/' + repo + '/git/ref/heads/' + encodeURIComponent(defaultBranch),
    { method: 'get' }
  );
  const sha = defaultRef.object.sha;

  githubRequest_('/repos/' + owner + '/' + repo + '/git/refs', {
    method: 'post',
    payload: { ref: 'refs/heads/' + branch, sha: sha }
  });
  return sha;
}

function toGitHubFileName_(file) {
  const name = String(file.name || 'Untitled');
  const type = String(file.type || '').toUpperCase();
  if (type === 'SERVER_JS') return name.endsWith('.gs') ? name : name + '.gs';
  if (type === 'HTML') return name.endsWith('.html') ? name : name + '.html';
  if (type === 'JSON') return name.endsWith('.json') ? name : name + '.json';
  return name;
}

function githubRequest_(path, options) {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) {
    throw new Error('Administrator setup required: GITHUB_TOKEN is missing from Script Properties.');
  }

  const opts = options || {};
  const params = {
    method: String(opts.method || 'get').toLowerCase(),
    muteHttpExceptions: true,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'GitScript'
    }
  };

  if (opts.payload !== undefined) {
    params.contentType = 'application/json';
    params.payload = JSON.stringify(opts.payload);
  }

  const response = UrlFetchApp.fetch(APP.GITHUB_API + path, params);
  const code = response.getResponseCode();
  const text = response.getContentText();
  let body = null;

  try {
    body = text ? JSON.parse(text) : {};
  } catch (_) {
    body = { message: text };
  }

  if (code < 200 || code >= 300) {
    const message = body && body.message ? body.message : 'GitHub request failed.';
    throw new Error('GitHub API error (' + code + '): ' + message);
  }

  return body;
}

/* ========================================================================== */
/* CONFIGURATION STORE                                                        */
/* ========================================================================== */

function getConfigSheet_() {
  const props = PropertiesService.getScriptProperties();
  let spreadsheetId = props.getProperty('CONFIG_SPREADSHEET_ID');
  let spreadsheet;

  if (spreadsheetId) {
    spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  } else {
    spreadsheet = SpreadsheetApp.create('GitScript — Configuration');
    spreadsheetId = spreadsheet.getId();
    props.setProperty('CONFIG_SPREADSHEET_ID', spreadsheetId);
  }

  let sheet = spreadsheet.getSheetByName(APP.SHEET_NAME);
  if (!sheet) sheet = spreadsheet.insertSheet(APP.SHEET_NAME);

  ensureSchema_(sheet);
  return sheet;
}

/**
 * Non-destructive migration from the original 8-column schema.
 * Existing "Status" is renamed to "Sync Status" and missing columns are appended.
 */
function ensureSchema_(sheet) {
  if (sheet.getLastRow() === 0 || sheet.getLastColumn() === 0) {
    sheet.getRange(1, 1, 1, APP.HEADERS.length).setValues([APP.HEADERS]);
    styleHeader_(sheet);
    return;
  }

  const width = Math.max(1, sheet.getLastColumn());
  const current = sheet.getRange(1, 1, 1, width).getValues()[0].map(value => String(value || '').trim());

  // Preserve the old Status data while moving to separate sync-state + lifecycle fields.
  const legacyStatusIndex = current.indexOf('Status');
  if (legacyStatusIndex !== -1 && current.indexOf('Sync Status') === -1) {
    current[legacyStatusIndex] = 'Sync Status';
    sheet.getRange(1, legacyStatusIndex + 1).setValue('Sync Status');
  }

  const refreshed = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), current.length)).getValues()[0]
    .map(value => String(value || '').trim());

  const missing = APP.HEADERS.filter(header => refreshed.indexOf(header) === -1);
  if (missing.length) {
    const startColumn = sheet.getLastColumn() + 1;
    sheet.getRange(1, startColumn, 1, missing.length).setValues([missing]);
  }

  styleHeader_(sheet);
  initializeLegacyRows_(sheet);
}

function styleHeader_(sheet) {
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, sheet.getLastColumn()).setFontWeight('bold');
}

function initializeLegacyRows_(sheet) {
  if (sheet.getLastRow() < 2) return;

  const map = getHeaderMap_(sheet);
  const rowCount = sheet.getLastRow() - 1;

  const lifecycleRange = sheet.getRange(2, map['Lifecycle'], rowCount, 1);
  const lifecycleValues = lifecycleRange.getValues();
  let lifecycleChanged = false;
  lifecycleValues.forEach(row => {
    if (!String(row[0] || '').trim()) {
      row[0] = 'active';
      lifecycleChanged = true;
    }
  });
  if (lifecycleChanged) lifecycleRange.setValues(lifecycleValues);

  const statusRange = sheet.getRange(2, map['Sync Status'], rowCount, 1);
  const statusValues = statusRange.getValues();
  let statusChanged = false;
  statusValues.forEach(row => {
    if (!String(row[0] || '').trim()) {
      row[0] = 'ready';
      statusChanged = true;
    }
  });
  if (statusChanged) statusRange.setValues(statusValues);

  const scheduleEnabledRange = sheet.getRange(2, map['Schedule Enabled'], rowCount, 1);
  const enabledValues = scheduleEnabledRange.getValues();
  let enabledChanged = false;
  enabledValues.forEach(row => {
    if (row[0] === '') {
      row[0] = false;
      enabledChanged = true;
    }
  });
  if (enabledChanged) scheduleEnabledRange.setValues(enabledValues);

  const scheduleTypeRange = sheet.getRange(2, map['Schedule Type'], rowCount, 1);
  const typeValues = scheduleTypeRange.getValues();
  let typeChanged = false;
  typeValues.forEach(row => {
    if (!String(row[0] || '').trim()) {
      row[0] = 'manual';
      typeChanged = true;
    }
  });
  if (typeChanged) scheduleTypeRange.setValues(typeValues);

  const timezoneRange = sheet.getRange(2, map['Schedule Timezone'], rowCount, 1);
  const tzValues = timezoneRange.getValues();
  const timezone = getScheduleTimeZone_();
  let tzChanged = false;
  tzValues.forEach(row => {
    if (!String(row[0] || '').trim()) {
      row[0] = timezone;
      tzChanged = true;
    }
  });
  if (tzChanged) timezoneRange.setValues(tzValues);
}

function getHeaders_(sheet) {
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(value => String(value || '').trim());
}

function getHeaderMap_(sheet) {
  const headers = getHeaders_(sheet);
  const map = {};
  headers.forEach((header, index) => { if (header) map[header] = index + 1; });
  return map;
}

function appendObjectRow_(sheet, headers, object) {
  const row = headers.map(header => Object.prototype.hasOwnProperty.call(object, header) ? object[header] : '');
  sheet.appendRow(row);
}

function setRowValuesByHeader_(sheet, row, map, object) {
  Object.keys(object).forEach(header => {
    if (!map[header]) throw new Error('Configuration schema is missing column: ' + header);
    const range = sheet.getRange(row, map[header]);
    const value = object[header];
    if (value === '' || value === null || value === undefined) range.clearContent();
    else range.setValue(value);
  });
}

function listConfigurations_() {
  const sheet = getConfigSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const headers = getHeaders_(sheet);
  const values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();

  return values
    .map((row, index) => rowToConfiguration_(row, headers, index + 2))
    .filter(config => config && config.id);
}

function findConfiguration_(id) {
  const target = String(id || '').trim();
  if (!target) return null;
  return listConfigurations_().find(config => config.id === target) || null;
}

function requireConfiguration_(id) {
  const config = findConfiguration_(id);
  if (!config) throw new Error('Integration mapping not found.');
  return config;
}

function rowToConfiguration_(row, headers, rowNumber) {
  const obj = {};
  headers.forEach((header, index) => { obj[header] = row[index]; });

  const id = String(obj['ID'] || '').trim();
  if (!id) return null;

  const lifecycle = normalizeLifecycle_(obj['Lifecycle']);
  const syncStatus = String(obj['Sync Status'] || 'ready').trim().toLowerCase() || 'ready';
  const timezone = String(obj['Schedule Timezone'] || getScheduleTimeZone_()).trim() || getScheduleTimeZone_();

  return {
    row: rowNumber,
    id: id,
    nickname: String(obj['Nickname'] || ''),
    scriptId: String(obj['Script ID'] || ''),
    repository: String(obj['Repository'] || ''),
    branch: String(obj['Branch'] || 'main'),
    createdAt: serializeDate_(obj['Created At']),
    lastPush: serializeDate_(obj['Last Push']),
    syncStatus: syncStatus,
    lifecycle: lifecycle,
    lastError: String(obj['Last Error'] || ''),
    archivedAt: serializeDate_(obj['Archived At']),
    schedule: {
      enabled: toBoolean_(obj['Schedule Enabled']),
      type: String(obj['Schedule Type'] || 'manual').toLowerCase(),
      intervalHours: obj['Schedule Interval Hours'] === '' ? null : Number(obj['Schedule Interval Hours']),
      hour: obj['Schedule Hour'] === '' ? null : Number(obj['Schedule Hour']),
      weekday: obj['Schedule Weekday'] === '' ? null : Number(obj['Schedule Weekday']),
      timezone: timezone,
      nextRun: serializeDate_(obj['Next Scheduled Sync']),
      lastRun: serializeDate_(obj['Last Scheduled Sync'])
    }
  };
}

function toPublicConfiguration_(config) {
  if (!config) return null;
  return {
    id: config.id,
    nickname: config.nickname,
    scriptId: config.scriptId,
    repository: config.repository,
    branch: config.branch,
    createdAt: config.createdAt,
    lastPush: config.lastPush,
    status: config.syncStatus, // Backwards compatibility with v1 frontend.
    syncStatus: config.syncStatus,
    lifecycle: config.lifecycle,
    lastError: config.lastError,
    archivedAt: config.archivedAt,
    schedule: {
      enabled: Boolean(config.schedule.enabled),
      type: config.schedule.type || 'manual',
      intervalHours: config.schedule.intervalHours,
      hour: config.schedule.hour,
      weekday: config.schedule.weekday,
      timezone: config.schedule.timezone,
      nextRun: config.schedule.nextRun,
      lastRun: config.schedule.lastRun
    },
    logs: buildConfigurationLogs_(config)
  };
}

function updateSyncState_(row, changes) {
  const sheet = getConfigSheet_();
  const map = getHeaderMap_(sheet);
  const values = {};

  if (Object.prototype.hasOwnProperty.call(changes, 'lastPush')) values['Last Push'] = changes.lastPush;
  if (Object.prototype.hasOwnProperty.call(changes, 'syncStatus')) values['Sync Status'] = changes.syncStatus;
  if (Object.prototype.hasOwnProperty.call(changes, 'lastError')) values['Last Error'] = changes.lastError;

  setRowValuesByHeader_(sheet, row, map, values);
}

function buildConfigurationLogs_(config) {
  const logs = [];

  if (config.lifecycle === 'active') logs.push('Mapping active');
  if (config.lifecycle === 'inactive') logs.push('Integration inactive · sync actions paused');
  if (config.lifecycle === 'archived') logs.push('Integration archived');

  if (config.schedule.enabled) {
    logs.push('Schedule: ' + describeSchedule_(config.schedule));
    if (config.schedule.nextRun) logs.push('Next scheduled sync: ' + serializeDate_(config.schedule.nextRun));
  } else {
    logs.push('Schedule: manual only');
  }

  if (config.lastPush) logs.push('Last push: ' + serializeDate_(config.lastPush));
  if (config.lastError) logs.push('Previous error: ' + config.lastError);

  return logs;
}

function describeSchedule_(schedule) {
  if (!schedule || !schedule.enabled) return 'Manual only';
  if (schedule.type === 'interval') return 'Every ' + schedule.intervalHours + ' hour' + (Number(schedule.intervalHours) === 1 ? '' : 's');
  if (schedule.type === 'daily') return 'Daily at ' + pad2_(schedule.hour) + ':00 · ' + schedule.timezone;
  if (schedule.type === 'weekly') {
    const weekday = APP.WEEKDAYS[Number(schedule.weekday)] || 'Selected day';
    return weekday + ' at ' + pad2_(schedule.hour) + ':00 · ' + schedule.timezone;
  }
  return 'Manual only';
}

/* ========================================================================== */
/* GENERIC HELPERS                                                            */
/* ========================================================================== */

function normalizeLifecycle_(value) {
  const lifecycle = String(value || 'active').toLowerCase();
  return APP.LIFECYCLES.indexOf(lifecycle) === -1 ? 'active' : lifecycle;
}

function normalizeBranch_(value) {
  const branch = String(value || 'main').trim();
  if (!branch || !/^[A-Za-z0-9._\/-]+$/.test(branch) || branch.startsWith('/') || branch.endsWith('/')) {
    throw new Error('Invalid Git branch name.');
  }
  if (branch.includes('..') || branch.includes('//') || branch.endsWith('.lock')) {
    throw new Error('Invalid Git branch name.');
  }
  return branch;
}

function toBoolean_(value) {
  if (value === true || value === false) return value;
  const text = String(value || '').trim().toLowerCase();
  return text === 'true' || text === '1' || text === 'yes' || text === 'on';
}

function pad2_(value) {
  return String(Number(value) || 0).padStart(2, '0');
}

function serializeDate_(value) {
  if (!value) return null;
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return value.toISOString();
  }
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function extractApiMessage_(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed.error && parsed.error.message ? parsed.error.message : (parsed.message || text);
  } catch (_) {
    return String(text || 'Unknown API error');
  }
}
