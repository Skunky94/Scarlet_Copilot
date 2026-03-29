#!/usr/bin/env node
// Scarlet Loop Guardian — Session Replay Harness (exp_004)
// Replays events from .scarlet/events.jsonl for debugging and post-mortem analysis.
//
// Usage:
//   node tools/replay.js                      # replay latest session
//   node tools/replay.js --all                # replay all sessions
//   node tools/replay.js --session N          # replay session N (1-based)
//   node tools/replay.js --filter drift       # filter by subsystem
//   node tools/replay.js --summary            # summary only, no event details

'use strict';

const fs = require('fs');
const path = require('path');

const EVENTS_PATH = path.join(__dirname, '..', '.scarlet', 'events.jsonl');
const SESSION_GAP_MS = 300000; // 5min gap = new session

// ─── Argument Parsing ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flags = {
    all: args.includes('--all'),
    summary: args.includes('--summary'),
    session: null,
    filter: null
};

const sessionIdx = args.indexOf('--session');
if (sessionIdx >= 0 && args[sessionIdx + 1]) flags.session = parseInt(args[sessionIdx + 1], 10);

const filterIdx = args.indexOf('--filter');
if (filterIdx >= 0 && args[filterIdx + 1]) flags.filter = args[filterIdx + 1].toLowerCase();

// ─── Event Loading ───────────────────────────────────────────────────────────

function loadEvents() {
    if (!fs.existsSync(EVENTS_PATH)) {
        console.error('No events file found at ' + EVENTS_PATH);
        process.exit(1);
    }
    const raw = fs.readFileSync(EVENTS_PATH, 'utf-8');
    return raw.trim().split('\n')
        .filter(Boolean)
        .map(line => {
            try { return JSON.parse(line); }
            catch { return null; }
        })
        .filter(Boolean);
}

// ─── Session Splitting ───────────────────────────────────────────────────────

function splitSessions(events) {
    if (!events.length) return [];
    const sessions = [];
    let current = [events[0]];

    for (let i = 1; i < events.length; i++) {
        const prevTs = new Date(events[i - 1].ts).getTime();
        const currTs = new Date(events[i].ts).getTime();
        if (currTs - prevTs > SESSION_GAP_MS) {
            sessions.push(current);
            current = [];
        }
        current.push(events[i]);
    }
    if (current.length) sessions.push(current);
    return sessions;
}

// ─── Formatting ──────────────────────────────────────────────────────────────

const COLORS = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m'
};

const SUBSYSTEM_COLORS = {
    drift: COLORS.yellow,
    phantom: COLORS.magenta,
    round: COLORS.dim,
    state: COLORS.blue,
    reflexion: COLORS.red,
    gate: COLORS.green,
    nudge: COLORS.cyan,
    idle: COLORS.white,
    gpt: COLORS.green,
    runtime: COLORS.red,
    autonomy: COLORS.red
};

function formatTimestamp(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString('it-IT', { hour12: false }) + '.' +
        String(d.getMilliseconds()).padStart(3, '0');
}

function formatEvent(evt) {
    const color = SUBSYSTEM_COLORS[evt.sub] || COLORS.white;
    const ts = formatTimestamp(evt.ts);
    const sub = (evt.sub || '???').padEnd(10);
    const event = evt.evt || '???';

    // Extract key details based on subsystem
    let details = '';
    if (evt.sub === 'drift' && evt.evt === 'quality_check') {
        details = ' score=' + (evt.score != null ? evt.score.toFixed(3) : '?') +
            (evt.shouldRepair ? ' → REPAIR' : '') +
            (evt.inRepair ? ' [in repair]' : '');
    } else if (evt.sub === 'drift' && evt.evt === 'repair_enter') {
        details = ' badWindows=' + evt.score;
    } else if (evt.sub === 'drift' && evt.evt === 'repair_exit') {
        details = ' reason=' + evt.reason + ' rounds=' + evt.roundsInRepair;
    } else if (evt.sub === 'phantom' && evt.evt === 'burst_detected') {
        details = ' consecutive=' + evt.consecutive;
    } else if (evt.sub === 'state' && evt.evt === 'transition') {
        details = ' ' + (evt.prev || '?') + ' → ' + (evt.next || '?') + ' reason=' + (evt.reason || '?');
    } else if (evt.sub === 'round') {
        const tools = evt.tools || [];
        details = ' tools=[' + tools.slice(0, 3).join(',') + (tools.length > 3 ? '...' : '') + ']';
    } else if (evt.sub === 'nudge') {
        details = ' purpose=' + (evt.purpose || '?');
    } else if (evt.sub === 'idle') {
        if (evt.taskId) details = ' task=' + evt.taskId;
    } else if (evt.sub === 'reflexion') {
        details = ' trigger=' + evt.evt.replace('trigger_', '');
    }

    return COLORS.dim + ts + COLORS.reset + ' ' +
        color + sub + COLORS.reset + ' ' +
        COLORS.bold + event + COLORS.reset +
        details;
}

// ─── Session Summary ─────────────────────────────────────────────────────────

function summarizeSession(events, sessionNum) {
    const start = new Date(events[0].ts);
    const end = new Date(events[events.length - 1].ts);
    const durationMin = ((end - start) / 60000).toFixed(1);

    const subsystems = {};
    let repairCount = 0, nudgeCount = 0, reflexionCount = 0, phantomBursts = 0;
    let driftScores = [];

    for (const evt of events) {
        subsystems[evt.sub] = (subsystems[evt.sub] || 0) + 1;

        if (evt.sub === 'drift' && evt.evt === 'repair_enter') repairCount++;
        if (evt.sub === 'nudge') nudgeCount++;
        if (evt.sub === 'reflexion') reflexionCount++;
        if (evt.sub === 'phantom' && evt.evt === 'burst_detected') phantomBursts++;
        if (evt.sub === 'drift' && evt.evt === 'quality_check' && evt.score != null) {
            driftScores.push(evt.score);
        }
    }

    const avgDrift = driftScores.length > 0
        ? (driftScores.reduce((a, b) => a + b, 0) / driftScores.length).toFixed(3)
        : 'N/A';
    const minDrift = driftScores.length > 0 ? Math.min(...driftScores).toFixed(3) : 'N/A';
    const maxDrift = driftScores.length > 0 ? Math.max(...driftScores).toFixed(3) : 'N/A';

    console.log('\n' + COLORS.bold + '═══ Session ' + sessionNum + ' ═══' + COLORS.reset);
    console.log('  Start:     ' + start.toLocaleString('it-IT'));
    console.log('  End:       ' + end.toLocaleString('it-IT'));
    console.log('  Duration:  ' + durationMin + ' min');
    console.log('  Events:    ' + events.length);
    console.log('  Subsystems:');
    Object.entries(subsystems)
        .sort((a, b) => b[1] - a[1])
        .forEach(([sub, count]) => {
            const color = SUBSYSTEM_COLORS[sub] || COLORS.white;
            console.log('    ' + color + sub.padEnd(12) + COLORS.reset + count);
        });
    console.log('  Repairs:   ' + repairCount);
    console.log('  Nudges:    ' + nudgeCount);
    console.log('  Reflexions:' + reflexionCount);
    console.log('  Phantom bursts: ' + phantomBursts);
    console.log('  Drift: avg=' + avgDrift + ' min=' + minDrift + ' max=' + maxDrift);
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
    const allEvents = loadEvents();
    console.log(COLORS.bold + 'Scarlet Replay Harness' + COLORS.reset +
        ' — ' + allEvents.length + ' events loaded');

    const sessions = splitSessions(allEvents);
    console.log('Sessions found: ' + sessions.length);

    // Select sessions to replay
    let selectedSessions;
    if (flags.all) {
        selectedSessions = sessions.map((s, i) => ({ events: s, num: i + 1 }));
    } else if (flags.session) {
        const idx = flags.session - 1;
        if (idx < 0 || idx >= sessions.length) {
            console.error('Session ' + flags.session + ' not found (have ' + sessions.length + ')');
            process.exit(1);
        }
        selectedSessions = [{ events: sessions[idx], num: flags.session }];
    } else {
        // Latest session
        selectedSessions = [{ events: sessions[sessions.length - 1], num: sessions.length }];
    }

    for (const { events, num } of selectedSessions) {
        let filtered = events;
        if (flags.filter) {
            filtered = events.filter(e => (e.sub || '').toLowerCase().includes(flags.filter));
        }

        summarizeSession(filtered, num);

        if (!flags.summary) {
            console.log('\n' + COLORS.dim + '─── Event Timeline ───' + COLORS.reset);
            for (const evt of filtered) {
                console.log(formatEvent(evt));
            }
        }
    }
}

main();
