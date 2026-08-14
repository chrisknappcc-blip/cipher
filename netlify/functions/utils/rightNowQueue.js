// netlify/functions/utils/rightNowQueue.js
// NEW FILE — path from repo root: netlify/functions/utils/rightNowQueue.js
//
// Merges signals (from hubspot.js scoreAllSignals output), HubSpot tasks,
// and to-do items into a single ranked "Right Now" queue.
//
// Two different time behaviors, on purpose:
//   - COOLING items (opens, clicks): score DECAYS the older the signal gets.
//     Someone who opened 3 days ago is not "hot" anymore.
//   - AGING items (unanswered replies, meeting requests, overdue tasks):
//     score INCREASES the longer they sit unactioned. Silence gets more
//     urgent over time, not less.
//
// Every item leaves this function with a `whyTag` — a plain-language reason
// string, generated from whichever factor drove the score. No AI call here;
// this is cheap and instant by design. Email content classification (a
// separate, later phase) will feed richer whyTags into this same shape.

const HOUR = 60 * 60 * 1000;

// Half-life per cooling signal type, in hours. Lower = decays faster.
const COOLING_HALF_LIFE = {
  OPEN:  4,
  CLICK: 6,
};

// Aging items ramp up urgency over these windows (hours), capped at maxMultiplier.
const AGING_CONFIG = {
  reply_unanswered:  { rampHours: 24, maxMultiplier: 2.0 },
  meeting_request:   { rampHours: 4,  maxMultiplier: 2.5 },
  task_overdue:      { rampHours: 48, maxMultiplier: 2.0 },
};

function hoursSince(isoTimestamp) {
  if (!isoTimestamp) return null;
  return (Date.now() - new Date(isoTimestamp).getTime()) / HOUR;
}

function coolingMultiplier(eventType, hoursAgo) {
  const halfLife = COOLING_HALF_LIFE[eventType] || 6;
  if (hoursAgo == null || hoursAgo < 0) return 1;
  return Math.pow(0.5, hoursAgo / halfLife);
}

function agingMultiplier(kind, hoursWaiting) {
  const cfg = AGING_CONFIG[kind];
  if (!cfg || hoursWaiting == null || hoursWaiting < 0) return 1;
  const ramped = 1 + (cfg.maxMultiplier - 1) * Math.min(hoursWaiting / cfg.rampHours, 1);
  return ramped;
}

// ── Signals (opens/clicks/replies, matching the real shape returned by
// GET /signals/recent — { type: "OPEN"|"CLICK"|"REPLY", timestamp, score, label, contactId, contact }) ─
function scoreSignalForQueue(signal) {
  const hoursAgo = hoursSince(signal.timestamp);
  const eventType = signal.type; // "OPEN" | "CLICK" | "REPLY"
  const replied = eventType === "REPLY";

  let queueScore = signal.score || 0;
  let whyTag;

  if (replied) {
    // Replies don't cool off — they wait for a response. Age them upward.
    const mult = agingMultiplier("reply_unanswered", hoursAgo);
    queueScore = queueScore * mult;
    whyTag = hoursAgo != null && hoursAgo >= 1
      ? `Replied ${Math.round(hoursAgo)}h ago, no response yet`
      : `Just replied`;
  } else {
    const mult = coolingMultiplier(eventType, hoursAgo);
    queueScore = queueScore * mult;
    const label = signal.label || (eventType === "OPEN" ? "Opened" : "Clicked");
    whyTag = hoursAgo != null
      ? `${label} · ${hoursAgo < 1 ? "under an hour ago" : `${Math.round(hoursAgo)}h ago`}`
      : label;
  }

  return {
    source: "signal",
    id: `sig-${signal.contactId || signal.id}`,
    contactId: signal.contactId || null,
    contact: signal.contact || null,
    label: signal.label,
    queueScore: Math.round(queueScore),
    whyTag,
    raw: signal,
  };
}
// Note: `replied` above comes from signal.type === "REPLY", not a boolean flag on the object.

// ── HubSpot tasks (due today / overdue, already fetched with hs_timestamp) ─
function scoreTaskForQueue(task) {
  const due = task.dueDate;
  const hoursUntilDue = due ? -hoursSince(due) : null; // negative hoursSince = future
  let queueScore = 40; // baseline for a scheduled task
  let whyTag;

  if (hoursUntilDue != null && hoursUntilDue < 0) {
    // Overdue — age it upward
    const hoursOverdue = Math.abs(hoursUntilDue);
    const mult = agingMultiplier("task_overdue", hoursOverdue);
    queueScore = queueScore * mult;
    whyTag = `Overdue task · ${Math.round(hoursOverdue)}h past due`;
  } else if (hoursUntilDue != null && hoursUntilDue <= 2) {
    queueScore = queueScore * 1.5;
    whyTag = `Due within ${Math.max(Math.round(hoursUntilDue), 0)}h`;
  } else {
    whyTag = `Task due today`;
  }

  return {
    source: "task",
    id: `task-${task.id}`,
    contactId: task.contactId || null,
    contact: task.contact || null,
    label: task.subject || task.text,
    queueScore: Math.round(queueScore),
    whyTag,
    raw: task,
  };
}

// ── Upcoming meetings ────────────────────────────────────────────────────────
// Meetings don't cool off and don't "age" the way overdue items do — they
// count DOWN as the date approaches, then stay visible and hot through the
// day of the meeting. They never silently disappear before that.
function scoreMeetingForQueue(meeting) {
  const hoursUntil = -hoursSince(meeting.startTime);
  let queueScore = 60; // baseline visibility floor, well above a cooling signal
  let whyTag;

  if (hoursUntil == null) {
    whyTag = "Meeting scheduled";
  } else if (hoursUntil <= 0) {
    // Meeting is today / in progress — max visibility
    queueScore = 150;
    whyTag = "Meeting today";
  } else if (hoursUntil <= 24) {
    queueScore = 130;
    whyTag = `Meeting tomorrow, ${Math.round(hoursUntil)}h out`;
  } else if (hoursUntil <= 72) {
    queueScore = 90;
    whyTag = `Meeting in ${Math.round(hoursUntil / 24)}d`;
  } else {
    queueScore = 60;
    whyTag = `Meeting in ${Math.round(hoursUntil / 24)}d`;
  }

  return {
    source: "meeting",
    id: `mtg-${meeting.id}`,
    contactId: meeting.contactId || null,
    contact: meeting.contact || null,
    label: meeting.subject,
    queueScore: Math.round(queueScore),
    whyTag,
    raw: meeting,
  };
}

// Auto-generates a "confirm this meeting" to-do exactly once per meeting,
// 3 days out. Idempotency is the tricky part: this must NOT recreate the
// task on every poll. Caller is expected to persist a `confirmationTaskId`
// (or similar flag) back onto the meeting record/blob once created — this
// function just decides whether one is due, it doesn't do the writing.
function needsConfirmationTask(meeting) {
  const hoursUntil = -hoursSince(meeting.startTime);
  const alreadyCreated = !!meeting.confirmationTaskCreated;
  // Fire once the meeting crosses into the 3-day window and stays true
  // until the caller marks it created — caller should check this on
  // every relevant poll and only act the first time it sees `true`.
  return !alreadyCreated && hoursUntil != null && hoursUntil <= 72 && hoursUntil > 0;
}

function buildConfirmationTodo(meeting) {
  return {
    id: `confirm-${meeting.id}`,
    contactId: meeting.contactId || null,
    text: `Confirm meeting with ${meeting.contact?.name || "contact"} on ${meeting.startTime}`,
    autoDetected: true,
    priority: "HIGH",
    createdAt: new Date().toISOString(),
    linkedMeetingId: meeting.id,
  };
}

// ── Manual / auto-detected to-dos ───────────────────────────────────────────
function scoreTodoForQueue(todo) {
  const base = todo.priority === "HIGH" ? 90 : typeof todo.priority === "number" ? 90 - todo.priority * 5 : 30;
  const hoursOld = hoursSince(todo.createdAt);
  // To-dos don't cool or age automatically — they're explicit asks.
  // Small aging nudge so stale to-dos don't get buried forever.
  const mult = hoursOld != null ? 1 + Math.min(hoursOld / 48, 0.5) : 1;
  return {
    source: "todo",
    id: `todo-${todo.id}`,
    contactId: todo.contactId || null,
    contact: null,
    label: todo.text,
    queueScore: Math.round(base * mult),
    whyTag: todo.subtext || (todo.autoDetected ? "Auto-detected" : "Manual to-do"),
    raw: todo,
  };
}

// ── Public entry point ──────────────────────────────────────────────────────
// signals: output of scoreAllSignals() from hubspot.js
// tasks:   HubSpot tasks already fetched with dueDate/contactId
// todos:   items from todoStore.getTodos()
export function buildRightNowQueue({ signals = [], tasks = [], todos = [], meetings = [] } = {}) {
  const scored = [
    ...signals.filter(s => s.contactId).map(scoreSignalForQueue),
    ...tasks.map(scoreTaskForQueue),
    ...todos.filter(t => !t.completed).map(scoreTodoForQueue),
    ...meetings.map(scoreMeetingForQueue),
  ];

  // Dedup by contactId: keep the highest-scoring item per contact so the
  // queue shows one line per person, not three.
  const byContact = new Map();
  for (const item of scored) {
    const key = item.contactId || item.id;
    const existing = byContact.get(key);
    if (!existing || item.queueScore > existing.queueScore) {
      byContact.set(key, item);
    }
  }

  return [...byContact.values()].sort((a, b) => b.queueScore - a.queueScore);
}

export { needsConfirmationTask, buildConfirmationTodo };
