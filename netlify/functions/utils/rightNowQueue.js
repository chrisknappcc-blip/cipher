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

// ── Signals (opens/clicks/replies from scoreAllSignals) ────────────────────
function scoreSignalForQueue(signal) {
  const hoursAgo = hoursSince(signal.timestamp);
  const eventType = signal.eventType || (signal.replied ? "REPLY" : signal.label?.startsWith("Opened") ? "OPEN" : "CLICK");

  let queueScore = signal.score || 0;
  let whyTag;

  if (signal.replied) {
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
export function buildRightNowQueue({ signals = [], tasks = [], todos = [] } = {}) {
  const scored = [
    ...signals.filter(s => s.contactId).map(scoreSignalForQueue),
    ...tasks.map(scoreTaskForQueue),
    ...todos.filter(t => !t.completed).map(scoreTodoForQueue),
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
