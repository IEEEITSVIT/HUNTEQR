import qrcode from 'qrcode-generator';

const enc = new TextEncoder();
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L lookalikes
const SESSION_SECONDS = 60 * 60 * 48;

// ---------- helpers ----------

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });

const fail = (message, status = 400) => json({ error: message }, status);

const redirect = (location) =>
  new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } });

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function randomCode(length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getCookie(req, name) {
  const header = req.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

function cookie(req, name, value, maxAge) {
  const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

async function signSession(env, subject) {
  const body = `${subject}.${Math.floor(Date.now() / 1000) + SESSION_SECONDS}`;
  return `${body}.${await hmac(env.SESSION_SECRET, body)}`;
}

async function readSession(req, env, name) {
  const raw = getCookie(req, name);
  if (!raw) return null;
  const [subject, exp, sig] = raw.split('.');
  if (!subject || !exp || !sig) return null;
  if (!safeEqual(sig, await hmac(env.SESSION_SECRET, `${subject}.${exp}`))) return null;
  if (Number(exp) < Date.now() / 1000) return null;
  return subject;
}

async function body(req) {
  try {
    const data = await req.json();
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

const text = (v, max) => String(v ?? '').trim().slice(0, max);

async function settings(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM hunt_settings').all();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}

const setSetting = (env, key, value) =>
  env.DB.prepare('INSERT INTO hunt_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, String(value));

async function currentParticipant(req, env) {
  const id = await readSession(req, env, 'hunt_p');
  if (!id) return null;
  return env.DB.prepare('SELECT * FROM hunt_participants WHERE id = ?').bind(Number(id)).first();
}

async function isAdmin(req, env) {
  return (await readSession(req, env, 'hunt_a')) === 'admin';
}

function writeSequence(env, teamId, clueIds) {
  return [
    env.DB.prepare('DELETE FROM hunt_sequence WHERE team_id = ?').bind(teamId),
    ...clueIds.map((clueId, i) =>
      env.DB.prepare('INSERT INTO hunt_sequence (team_id, position, clue_id) VALUES (?, ?, ?)').bind(teamId, i, clueId)),
  ];
}

// ---------- participant API ----------

async function login(req, env) {
  const data = await body(req);
  const code = text(data.code, 12).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const name = text(data.name, 60);
  const regNo = text(data.regNo, 20).toUpperCase();
  if (!code || !name || !regNo) return fail('Team code, name and registration number are all required.');

  const team = await env.DB.prepare('SELECT id FROM hunt_teams WHERE code = ?').bind(code).first();
  if (!team) return fail('That team code was not recognised. Check it with the organisers.', 401);

  let p = await env.DB.prepare('SELECT id, consent_at FROM hunt_participants WHERE team_id = ? AND reg_no = ?').bind(team.id, regNo).first();
  if (!p) {
    p = await env.DB.prepare('INSERT INTO hunt_participants (team_id, name, reg_no) VALUES (?, ?, ?) RETURNING id, consent_at')
      .bind(team.id, name, regNo).first();
  }
  return json({ ok: true, consented: !!p.consent_at }, 200, {
    'set-cookie': cookie(req, 'hunt_p', await signSession(env, p.id), SESSION_SECONDS),
  });
}

async function consent(req, env) {
  const p = await currentParticipant(req, env);
  if (!p) return fail('Please log in first.', 401);
  const data = await body(req);
  if (data.agree !== true) return fail('You must accept every point to take part.');
  await env.DB.prepare("UPDATE hunt_participants SET consent_at = COALESCE(consent_at, datetime('now')) WHERE id = ?").bind(p.id).run();
  return json({ ok: true });
}

async function me(req, env) {
  const p = await currentParticipant(req, env);
  if (!p) return fail('Please log in first.', 401);
  const team = await env.DB.prepare('SELECT * FROM hunt_teams WHERE id = ?').bind(p.team_id).first();
  if (!team) return fail('Your team no longer exists. Please see the organisers.', 401);

  const s = await settings(env);
  const total = (await env.DB.prepare('SELECT COUNT(*) AS n FROM hunt_sequence WHERE team_id = ?').bind(team.id).first()).n;
  const out = {
    eventName: s.event_name,
    status: s.status,
    participant: { name: p.name },
    consented: !!p.consent_at,
    team: { name: team.name, progress: team.progress, total, finished: !!team.finished_at },
    clue: null,
  };
  // The clue text only ever leaves the server for a consented member of a team that is on that step.
  if (out.consented && s.status === 'live' && team.progress < total) {
    const clue = await env.DB.prepare(
      'SELECT c.clue_text FROM hunt_sequence s JOIN hunt_clues c ON c.id = s.clue_id WHERE s.team_id = ? AND s.position = ?',
    ).bind(team.id, team.progress).first();
    if (clue) out.clue = { number: team.progress + 1, text: clue.clue_text };
  }
  return json(out);
}

// GET /s/:token is what every printed QR points at.
async function scan(req, env, token) {
  const here = `/s/${encodeURIComponent(token)}`;
  const p = await currentParticipant(req, env);
  if (!p) return redirect(`/?next=${encodeURIComponent(here)}`);
  if (!p.consent_at) return redirect(`/consent?next=${encodeURIComponent(here)}`);

  const team = await env.DB.prepare('SELECT * FROM hunt_teams WHERE id = ?').bind(p.team_id).first();
  if (!team) return redirect('/');

  const done = async (result, clueId = null) => {
    await env.DB.prepare('INSERT INTO hunt_scans (team_id, participant_id, clue_id, result) VALUES (?, ?, ?, ?)')
      .bind(team.id, p.id, clueId, result).run();
    return redirect(`/play?r=${result}`);
  };

  const s = await settings(env);
  if (s.status !== 'live') return redirect('/play?r=notlive');

  const clue = await env.DB.prepare('SELECT id FROM hunt_clues WHERE token = ?').bind(token).first();
  if (!clue) return done('invalid');

  const { results: seq } = await env.DB.prepare('SELECT position, clue_id FROM hunt_sequence WHERE team_id = ? ORDER BY position').bind(team.id).all();
  if (!seq.length) return redirect('/play?r=noseq');
  if (team.progress >= seq.length) return redirect('/play?r=done');

  if (seq[team.progress].clue_id === clue.id) {
    const finishing = team.progress + 1 >= seq.length;
    // The progress guard makes two teammates scanning at the same moment count once.
    const res = await env.DB.prepare(
      `UPDATE hunt_teams SET progress = progress + 1, last_advance_at = strftime('%Y-%m-%d %H:%M:%f', 'now'),
       finished_at = CASE WHEN ? THEN strftime('%Y-%m-%d %H:%M:%f', 'now') ELSE finished_at END
       WHERE id = ? AND progress = ?`,
    ).bind(finishing ? 1 : 0, team.id, team.progress).run();
    if (!res.meta.changes) return redirect('/play?r=already');
    return done(finishing ? 'finish' : 'ok', clue.id);
  }
  const earlier = seq.some((row) => row.position < team.progress && row.clue_id === clue.id);
  return done(earlier ? 'already' : 'wrong', clue.id);
}

// ---------- admin API ----------

async function adminLogin(req, env) {
  const data = await body(req);
  const user = await hmac(env.SESSION_SECRET, text(data.username, 100));
  const pass = await hmac(env.SESSION_SECRET, String(data.password ?? ''));
  const okUser = safeEqual(user, await hmac(env.SESSION_SECRET, env.ADMIN_USER || 'admin'));
  const okPass = safeEqual(pass, await hmac(env.SESSION_SECRET, env.ADMIN_PASSWORD));
  if (!okUser || !okPass) return fail('Wrong username or password.', 401);
  return json({ ok: true }, 200, { 'set-cookie': cookie(req, 'hunt_a', await signSession(env, 'admin'), SESSION_SECONDS) });
}

async function adminState(req, env) {
  const [s, teams, clues, seq, people] = await Promise.all([
    settings(env),
    env.DB.prepare('SELECT * FROM hunt_teams ORDER BY id').all(),
    env.DB.prepare('SELECT * FROM hunt_clues ORDER BY id').all(),
    env.DB.prepare('SELECT team_id, clue_id FROM hunt_sequence ORDER BY team_id, position').all(),
    env.DB.prepare('SELECT id, team_id, name, reg_no, consent_at FROM hunt_participants ORDER BY id').all(),
  ]);
  const byTeam = {};
  for (const row of seq.results) (byTeam[row.team_id] ||= []).push(row.clue_id);
  return json({
    eventName: s.event_name,
    status: s.status,
    startedAt: s.started_at || null,
    origin: new URL(req.url).origin,
    teams: teams.results.map((t) => ({
      id: t.id, name: t.name, code: t.code, progress: t.progress,
      lastAdvanceAt: t.last_advance_at, finishedAt: t.finished_at, sequence: byTeam[t.id] || [],
    })),
    clues: clues.results.map((c) => ({ id: c.id, teamId: c.team_id, title: c.title, clueText: c.clue_text, token: c.token, isFinal: !!c.is_final })),
    participants: people.results.map((p) => ({ id: p.id, teamId: p.team_id, name: p.name, regNo: p.reg_no, consentAt: p.consent_at })),
  });
}

async function newTeamCodes(env, count) {
  const { results } = await env.DB.prepare('SELECT code FROM hunt_teams').all();
  const taken = new Set(results.map((r) => r.code));
  const codes = [];
  while (codes.length < count) {
    const code = randomCode(6);
    if (!taken.has(code)) { taken.add(code); codes.push(code); }
  }
  return codes;
}

async function generateTeams(req, env) {
  const data = await body(req);
  const count = Math.floor(Number(data.count));
  if (!(count >= 1 && count <= 200)) return fail('Number of teams must be between 1 and 200.');
  const prefix = text(data.prefix, 30) || 'Team';
  const existing = (await env.DB.prepare('SELECT COUNT(*) AS n FROM hunt_teams').first()).n;
  const codes = await newTeamCodes(env, count);
  await env.DB.batch(codes.map((code, i) =>
    env.DB.prepare('INSERT INTO hunt_teams (name, code) VALUES (?, ?)').bind(`${prefix} ${existing + i + 1}`, code)));
  return json({ ok: true, created: count });
}

async function renameTeam(req, env, id) {
  const name = text((await body(req)).name, 60);
  if (!name) return fail('Team name cannot be empty.');
  await env.DB.prepare('UPDATE hunt_teams SET name = ? WHERE id = ?').bind(name, id).run();
  return json({ ok: true });
}

async function deleteTeam(env, id) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM hunt_sequence WHERE team_id = ?').bind(id),
    env.DB.prepare('DELETE FROM hunt_scans WHERE team_id = ?').bind(id),
    env.DB.prepare('DELETE FROM hunt_participants WHERE team_id = ?').bind(id),
    env.DB.prepare('DELETE FROM hunt_clues WHERE team_id = ?').bind(id),
    env.DB.prepare('DELETE FROM hunt_teams WHERE id = ?').bind(id),
  ]);
  return json({ ok: true });
}

async function saveClue(req, env, id) {
  const data = await body(req);
  const title = text(data.title, 80);
  const clueText = text(data.clueText, 2000);
  const isFinal = data.isFinal ? 1 : 0;
  if (!title || !clueText) return fail('A clue needs both a location label and the clue text.');
  // The treasure clue is shared by every team; every other clue belongs to exactly one team.
  let teamId = null;
  if (!isFinal) {
    teamId = Number(data.teamId);
    const team = teamId ? await env.DB.prepare('SELECT id FROM hunt_teams WHERE id = ?').bind(teamId).first() : null;
    if (!team) return fail('Choose which team this clue is for, or mark it as the treasure clue.');
  }
  if (id) {
    await env.DB.prepare('UPDATE hunt_clues SET title = ?, clue_text = ?, is_final = ?, team_id = ? WHERE id = ?')
      .bind(title, clueText, isFinal, teamId, id).run();
  } else {
    await env.DB.prepare('INSERT INTO hunt_clues (title, clue_text, token, is_final, team_id) VALUES (?, ?, ?, ?, ?)')
      .bind(title, clueText, randomCode(12), isFinal, teamId).run();
  }
  return json({ ok: true });
}

async function deleteClue(env, id) {
  if ((await settings(env)).status === 'live') return fail('End or pause the hunt before deleting a clue.', 409);
  const { results } = await env.DB.prepare('SELECT team_id, clue_id FROM hunt_sequence ORDER BY team_id, position').all();
  const byTeam = {};
  for (const row of results) (byTeam[row.team_id] ||= []).push(row.clue_id);
  const statements = [env.DB.prepare('DELETE FROM hunt_clues WHERE id = ?').bind(id)];
  for (const [teamId, ids] of Object.entries(byTeam)) {
    if (ids.includes(id)) statements.push(...writeSequence(env, Number(teamId), ids.filter((c) => c !== id)));
  }
  await env.DB.batch(statements);
  return json({ ok: true });
}

async function generateSequences(req, env) {
  const data = await body(req);
  const mode = data.mode === 'shuffle' ? 'shuffle' : 'entered';
  const onlyMissing = !!data.onlyMissing;
  const s = await settings(env);
  if (s.status === 'live' && !onlyMissing) return fail('The hunt is live. Regenerating every route would reset all teams, so end it first.', 409);

  const [{ results: teams }, { results: clues }, { results: have }] = await Promise.all([
    env.DB.prepare('SELECT id, name FROM hunt_teams ORDER BY id').all(),
    env.DB.prepare('SELECT id, is_final, team_id FROM hunt_clues ORDER BY id').all(),
    env.DB.prepare('SELECT DISTINCT team_id FROM hunt_sequence').all(),
  ]);
  if (!teams.length) return fail('Create teams first.');
  const finals = clues.filter((c) => c.is_final).map((c) => c.id);
  if (!finals.length) return fail('Add the treasure clue first: it is the last stop for every team.');

  const assigned = new Set(have.map((r) => r.team_id));
  const statements = [];
  const empty = [];
  let changed = 0;
  for (const team of teams) {
    if (onlyMissing && assigned.has(team.id)) continue;
    // Each team's route is its own clues, then the shared treasure clue.
    let own = clues.filter((c) => !c.is_final && c.team_id === team.id).map((c) => c.id);
    if (!own.length) empty.push(team.name);
    if (mode === 'shuffle') own = shuffle(own);
    statements.push(...writeSequence(env, team.id, [...own, ...finals]));
    statements.push(env.DB.prepare('UPDATE hunt_teams SET progress = 0, last_advance_at = NULL, finished_at = NULL WHERE id = ?').bind(team.id));
    statements.push(env.DB.prepare('DELETE FROM hunt_scans WHERE team_id = ?').bind(team.id));
    changed++;
  }
  if (statements.length) await env.DB.batch(statements);
  return json({ ok: true, teams: changed, teamsWithoutOwnClues: empty });
}

async function setTeamSequence(req, env, teamId) {
  const ids = (await body(req)).clueIds;
  if (!Array.isArray(ids) || !ids.length) return fail('Give at least one clue.');
  const { results } = await env.DB.prepare('SELECT id FROM hunt_clues WHERE team_id = ? OR is_final = 1').bind(teamId).all();
  const valid = new Set(results.map((r) => r.id));
  if (ids.some((id) => !valid.has(id))) return fail("A route can only use that team's own clues and the treasure clue.");
  if (new Set(ids).size !== ids.length) return fail('A clue can only appear once in a route.');
  const team = await env.DB.prepare('SELECT progress FROM hunt_teams WHERE id = ?').bind(teamId).first();
  if (!team) return fail('Team not found.', 404);
  await env.DB.batch(writeSequence(env, teamId, ids));
  return json({ ok: true });
}

async function setStatus(req, env) {
  const status = (await body(req)).status;
  if (!['draft', 'live', 'ended'].includes(status)) return fail('Unknown status.');
  if (status === 'live') {
    const missing = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM hunt_teams t WHERE NOT EXISTS (SELECT 1 FROM hunt_sequence s WHERE s.team_id = t.id)',
    ).first();
    const teams = (await env.DB.prepare('SELECT COUNT(*) AS n FROM hunt_teams').first()).n;
    if (!teams) return fail('Create teams before starting.');
    if (missing.n) return fail(`${missing.n} team(s) have no route yet. Generate routes first.`);
  }
  const statements = [setSetting(env, 'status', status)];
  const s = await settings(env);
  if (status === 'live' && !s.started_at) statements.push(setSetting(env, 'started_at', new Date().toISOString()));
  await env.DB.batch(statements);
  return json({ ok: true });
}

async function resetProgress(env) {
  await env.DB.batch([
    env.DB.prepare('UPDATE hunt_teams SET progress = 0, last_advance_at = NULL, finished_at = NULL'),
    env.DB.prepare('DELETE FROM hunt_scans'),
    env.DB.prepare("DELETE FROM hunt_settings WHERE key = 'started_at'"),
    setSetting(env, 'status', 'draft'),
  ]);
  return json({ ok: true });
}

async function qrSvg(req, env, id) {
  const clue = await env.DB.prepare('SELECT token FROM hunt_clues WHERE id = ?').bind(id).first();
  if (!clue) return fail('Clue not found.', 404);
  const qr = qrcode(0, 'M');
  qr.addData(`${new URL(req.url).origin}/s/${clue.token}`);
  qr.make();
  return new Response(qr.createSvgTag({ cellSize: 8, margin: 16, scalable: true }), {
    headers: { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' },
  });
}

// ---------- router ----------

async function route(req, env) {
  const url = new URL(req.url);
  const path = url.pathname;
  const m = req.method;
  let match;

  if (!env.SESSION_SECRET || !env.ADMIN_PASSWORD) {
    return fail('Server is not configured: set the ADMIN_PASSWORD and SESSION_SECRET secrets.', 500);
  }

  if (m === 'GET' && (match = path.match(/^\/s\/([A-Za-z0-9]{1,40})$/))) return scan(req, env, match[1].toUpperCase());

  if (path === '/api/login' && m === 'POST') return login(req, env);
  if (path === '/api/consent' && m === 'POST') return consent(req, env);
  if (path === '/api/me' && m === 'GET') return me(req, env);
  if (path === '/api/logout' && m === 'POST') return json({ ok: true }, 200, { 'set-cookie': cookie(req, 'hunt_p', '', 0) });

  if (path === '/api/admin/login' && m === 'POST') return adminLogin(req, env);
  if (path.startsWith('/api/admin/')) {
    if (!(await isAdmin(req, env))) return fail('Admin login required.', 401);
    if (path === '/api/admin/logout' && m === 'POST') return json({ ok: true }, 200, { 'set-cookie': cookie(req, 'hunt_a', '', 0) });
    if (path === '/api/admin/state' && m === 'GET') return adminState(req, env);
    if (path === '/api/admin/settings' && m === 'PUT') {
      const name = text((await body(req)).eventName, 80);
      if (!name) return fail('Event name cannot be empty.');
      await setSetting(env, 'event_name', name).run();
      return json({ ok: true });
    }
    if (path === '/api/admin/status' && m === 'POST') return setStatus(req, env);
    if (path === '/api/admin/reset-progress' && m === 'POST') return resetProgress(env);
    if (path === '/api/admin/teams/generate' && m === 'POST') return generateTeams(req, env);
    if (path === '/api/admin/sequences/generate' && m === 'POST') return generateSequences(req, env);
    if ((match = path.match(/^\/api\/admin\/teams\/(\d+)\/sequence$/)) && m === 'PUT') return setTeamSequence(req, env, Number(match[1]));
    if ((match = path.match(/^\/api\/admin\/teams\/(\d+)$/))) {
      if (m === 'PATCH') return renameTeam(req, env, Number(match[1]));
      if (m === 'DELETE') return deleteTeam(env, Number(match[1]));
    }
    if (path === '/api/admin/clues' && m === 'POST') return saveClue(req, env, null);
    if ((match = path.match(/^\/api\/admin\/clues\/(\d+)$/))) {
      if (m === 'PUT') return saveClue(req, env, Number(match[1]));
      if (m === 'DELETE') return deleteClue(env, Number(match[1]));
    }
    if ((match = path.match(/^\/api\/admin\/qr\/(\d+)\.svg$/)) && m === 'GET') return qrSvg(req, env, Number(match[1]));
  }

  if (path.startsWith('/api/') || path.startsWith('/s/')) return fail('Not found.', 404);
  return env.ASSETS.fetch(req);
}

export default {
  async fetch(req, env) {
    try {
      return await route(req, env);
    } catch (err) {
      console.error(err);
      return fail('Something went wrong on the server. Please try again.', 500);
    }
  },
};
