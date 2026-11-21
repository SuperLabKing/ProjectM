"use strict";
/*
 * dotpm Live Description
 * 一个独立、低侵入的 Obsidian 插件：为 dotpm 任务弹窗的 Description 增加
 * 实时 Markdown 渲染（Live Preview 近似），不修改 dotpm 源码、数据模型与保存逻辑。
 *
 * 设计原则：
 * 1) 原始 textarea 始终是唯一数据源，插件只读它、只渲染，不写回；
 * 2) 所有写回都通过 dotpm 自己的 input/change 流程，避免双写；
 * 3) 卸载时把 DOM 完整还原，dotpm 行为回到原样。
 */
const { Plugin, PluginSettingTab, Setting, MarkdownRenderer, Menu, Modal, Notice, Scope, FuzzySuggestModal, setIcon, getFrontMatterInfo, parseYaml } = require("obsidian");

const SECTION_SEL = ".pm-modal-desc-section";
const TEXTAREA_SEL = "textarea.pm-modal-description";
const PREVIEW_SEL = ".pm-modal-desc-preview";

function descriptionStructureChanged(records, selector) {
  return records.some(({ target, addedNodes, removedNodes }) =>
    !target.closest?.(".cm-editor") &&
    [...addedNodes, ...removedNodes].some(node =>
      node.nodeType === 1 && (node.matches(selector) || node.querySelector(selector))));
}

const { Decoration, EditorView, ViewPlugin, WidgetType } = require("@codemirror/view");
const { EditorSelection, EditorState, MapMode, Prec, StateEffect, Text, Transaction, findClusterBreak } = require("@codemirror/state");
const refreshInlineTime = StateEffect.define();
const TIME_KIND = { "计划": "plan", "开始": "start", "进行": "start", "完成": "done", "搁置": "hold", "取消": "cancel" };
const TIME_MARKER = /\*?(计划|开始|进行|完成|搁置|取消) @[ \t]?(~\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?|\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?(?:~(?:\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?|\d{2}:\d{2}))?)(?:（始于 @[ \t]?(\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?)）)?(?:[ \t]*([（(]耗时 (?:\d+天(?:\d+小时)?(?:\d+分)?|\d+小时(?:\d+分)?(?:\d+秒)?|\d+分(?:\d+秒)?|\d+秒)[）)]))?(?![\d:])\*?/g;
const LEGACY_PLAN = /<span class="pm-time pm-time--plan">(?:<span[^>]*>[^<]*<\/span>|[^<])*<\/span>/g;
const TASK_LINE = /^\s*(?:[-*+]|\d+\.)\s+\[(?: |x|X)\]/;

// Segment start (or completion time), accumulated milliseconds, original start, optional automatic parent state.
const TASK_CLOCK = /[ \t]*%%dotpm-clock:(\d+),(\d+)(?:,(\d+)(?:,auto-(cancel|hold))?)?%%/;

function taskTimestamp(now) {
  const date = new Date(now);
  const pad = n => String(n).padStart(2, "0");
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) +
    " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
}

function plannedOverdueDays(date, today) {
  const [start, end] = date.split("~");
  if (!end) return 0;
  // Same-day timed ranges store only the time after the tilde.
  const deadline = (end.includes("-") ? end : start).slice(0, 10);
  const midnight = Date.parse(deadline + "T00:00:00Z");
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== deadline) return 0;
  return Math.max(0, (today - midnight) / 86400000);
}

function formatElapsed(milliseconds) {
  const totalMinutes = Math.round(milliseconds / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;
  const duration = (days ? days + "天" : "") + (hours ? hours + "小时" : "") + (minutes ? minutes + "分" : "");
  return duration || "0分";
}

const RUNNING_TIME_FREQUENCIES = {
  15: "15 秒",
  30: "30 秒",
  60: "1 分钟（默认）",
  120: "2 分钟",
  300: "5 分钟",
};
const runningTimeTimers = new WeakMap();

class RunningTimeWidget extends WidgetType {
  constructor(segment, accumulated, refreshSeconds) {
    super();
    this.segment = segment;
    this.accumulated = accumulated;
    this.refreshSeconds = refreshSeconds;
  }

  eq(other) {
    return this.segment === other.segment && this.accumulated === other.accumulated &&
      this.refreshSeconds === other.refreshSeconds;
  }

  toDOM(view) {
    const doc = view.dom.ownerDocument;
    const badge = doc.createElement("span");
    badge.className = "pm-time pm-time--start pm-time--markdown pm-time--running";
    const update = () => {
      const elapsed = this.accumulated + Math.max(0, Date.now() - this.segment);
      const text = "耗时 " + formatElapsed(elapsed);
      if (badge.textContent !== text) badge.textContent = text;
      // Align the refresh interval with the half-minute rounding boundary.
      const interval = this.refreshSeconds * 1000;
      const delay = interval - ((elapsed + 30000) % interval);
      runningTimeTimers.set(badge, doc.defaultView.setTimeout(update, delay));
    };
    update();
    return badge;
  }

  destroy(badge) {
    badge.ownerDocument.defaultView.clearTimeout(runningTimeTimers.get(badge));
    runningTimeTimers.delete(badge);
  }
}

function durationParen(glyph, position) {
  return Decoration.mark({ class: "dotpm-duration-paren", attributes: { "data-glyph": glyph } })
    .range(position, position + 1);
}

const compactTimeCards = new WeakMap();
const activeCompactTimeBadges = new WeakMap();

function hideCompactTimeCard(badge, immediate = false) {
  const state = compactTimeCards.get(badge);
  if (!state) return;
  const win = badge.ownerDocument.defaultView;
  win.clearTimeout(state.timer);
  const remove = () => {
    state.card.remove();
    win.removeEventListener("scroll", state.hide, true);
    compactTimeCards.delete(badge);
    const doc = badge.ownerDocument;
    if (activeCompactTimeBadges.get(doc) === badge) activeCompactTimeBadges.delete(doc);
  };
  if (immediate) remove();
  else {
    state.card.classList.remove("is-open");
    state.timer = win.setTimeout(remove, 180);
  }
}

class CompactTaskTimeWidget extends WidgetType {
  constructor(match, overdueDays) {
    super();
    const [, label, date, start, elapsed] = match;
    const days = [...date.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)];
    const currentYear = new Date().getFullYear();
    const firstYear = Number(days[0][1]);
    this.yearMarker = "";
    if (days.some(day => Number(day[1]) !== firstYear)) this.yearMarker = "⇄";
    else if (firstYear < currentYear) this.yearMarker = "↶";
    else if (firstYear > currentYear) this.yearMarker = "↷";
    this.kind = TIME_KIND[label];
    this.deadlineOnly = label === "计划" && date.startsWith("~");
    this.label = this.deadlineOnly ? "截止" : label;
    this.shortDates = days.map(([, , month, day]) => Number(month) + "/" + Number(day));
    if (this.kind === "plan" && !this.deadlineOnly && date.includes("~") && this.shortDates.length === 1) {
      this.shortDates.push(this.shortDates[0]);
    }
    this.overdue = overdueDays ? "逾期 " + overdueDays + "天" : "";
    this.details = [
      this.deadlineOnly ? date.slice(1) : date.replace("~", " ~ "),
      start ? "始于 " + start : "",
      elapsed ? elapsed.slice(1, -1) : "",
      this.overdue,
    ].filter(Boolean);
    this.dateOffset = match[0].indexOf(date) - Number(match[0].startsWith("*"));
  }

  eq(other) {
    return this.kind === other.kind && this.label === other.label && this.dateOffset === other.dateOffset &&
      this.yearMarker === other.yearMarker &&
      this.details.join("\n") === other.details.join("\n");
  }

  toDOM(view) {
    const doc = view.dom.ownerDocument;
    const badge = doc.createElement("span");
    badge.className = "pm-time pm-time--markdown pm-time--" + this.kind + " dotpm-time-compact";
    if (this.yearMarker) badge.dataset.yearMarker = this.yearMarker;
    badge.textContent = this.label + " " + this.shortDates.join("~");
    if (this.overdue) badge.classList.add("dotpm-time-overdue");
    badge.setAttribute("aria-label", [this.label, ...this.details].join("，"));
    badge.addEventListener("mouseenter", () => {
      const previous = activeCompactTimeBadges.get(doc);
      if (previous && previous !== badge) hideCompactTimeCard(previous, true);
      activeCompactTimeBadges.set(doc, badge);
      const win = doc.defaultView;
      let state = compactTimeCards.get(badge);
      if (state) win.clearTimeout(state.timer);
      else {
        const card = doc.createElement("div");
        card.className = "dotpm-time-detail";
        card.dataset.timeState = this.kind;
        card.setAttribute("aria-hidden", "true");
        const heading = doc.createElement("strong");
        heading.textContent = this.label;
        card.appendChild(heading);
        for (const detail of this.details) {
          const row = doc.createElement("div");
          row.textContent = detail;
          card.appendChild(row);
        }
        (badge.closest(".modal-container") || doc.body).appendChild(card);
        const hide = () => hideCompactTimeCard(badge, true);
        state = { card, hide };
        compactTimeCards.set(badge, state);
        win.addEventListener("scroll", hide, true);
      }
      const rect = badge.getBoundingClientRect();
      const card = state.card;
      const width = card.offsetWidth;
      const height = card.offsetHeight;
      card.style.left = Math.max(8, Math.min(rect.left, win.innerWidth - width - 8)) + "px";
      card.style.top = Math.max(8, rect.bottom + height + 16 <= win.innerHeight
        ? rect.bottom + 7 : rect.top - height - 7) + "px";
      card.classList.add("is-open");
    });
    badge.addEventListener("mouseleave", () => hideCompactTimeCard(badge));
    badge.addEventListener("click", () => {
      const anchor = view.posAtDOM(badge, 0) + this.dateOffset + 1;
      hideCompactTimeCard(badge, true);
      view.dispatch({ selection: { anchor }, userEvent: "select.pointer" });
      view.focus();
    });
    return badge;
  }

  destroy(badge) {
    hideCompactTimeCard(badge, true);
  }
}

function usesCompactTime(view) {
  return !!view.dom.closest(".dotpm-live-native, .markdown-source-view.is-live-preview");
}

function timeDecorations(view, { showRunningTime, runningTimeRefreshSeconds }, tasks, compact) {
  const { progress } = tasks;
  const ranges = [];
  const seen = new Set();
  const embedded = view.dom.closest(".dotpm-live-native");
  const now = new Date();
  // Compare calendar dates on a UTC scale so DST cannot shift the day count.
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to;) {
      const line = view.state.doc.lineAt(pos);
      pos = line.to + 1;
      if (seen.has(line.number)) continue;
      seen.add(line.number);
      const tabs = embedded && /^(\t+)[-*+][ \t]+/.exec(line.text)?.[1];
      if (tabs) {
        ranges.push(Decoration.line({
          class: "dotpm-tabbed-list",
          attributes: { style: "--dotpm-list-tabs:" + tabs.length },
        }).range(line.from));
      }
      const children = progress.children.get(line.number);
      if (children) {
        ranges.push(Decoration.line({ class: "dotpm-derived-task-parent" }).range(line.from));
        ranges.push(Decoration.widget({
          widget: new TaskProgressWidget("子任务", children, TASK_LINE.test(line.text) ? tasks : null), side: 2,
        }).range(line.to));
      }
      const matches = [...line.text.matchAll(TIME_MARKER)];
      const status = matches.findLast(match => match[1] !== "计划");
      const isTask = TASK_LINE.test(line.text);
      let showOverdue = false;
      if (isTask) {
        if (compact && matches.some(match => match[1] === "计划" && match[2].includes("~"))) {
          const { current } = InlineTaskState.readState(line.text);
          showOverdue = current !== "done" && current !== "cancel";
        }
        if (status) {
          ranges.push(Decoration.line({ class: "dotpm-time-row dotpm-time-row--" + TIME_KIND[status[1]] }).range(line.from));
        }
        const clock = TASK_CLOCK.exec(line.text);
        if (clock) {
          ranges.push(Decoration.replace({}).range(line.from + clock.index, line.from + clock.index + clock[0].length));
          if (showRunningTime && status && TIME_KIND[status[1]] === "start" && Number(clock[1]) > 0) {
            ranges.push(Decoration.widget({
              widget: new RunningTimeWidget(Number(clock[1]), Number(clock[2]), runningTimeRefreshSeconds),
              side: 1,
            }).range(line.from + status.index + status[0].length));
          }
        }
      }
      for (const match of matches) {
        const from = line.from + match.index;
        const to = from + match[0].length;
        const start = from + Number(match[0].startsWith("*"));
        const end = to - Number(match[0].endsWith("*"));
        const editing = view.state.selection.ranges.some(range => range.from < end && range.to > start);
        if (compact && !editing) {
          const overdue = showOverdue && match[1] === "计划" ? plannedOverdueDays(match[2], today) : 0;
          ranges.push(Decoration.replace({ widget: new CompactTaskTimeWidget(match, overdue) }).range(start, end));
          continue;
        }
        ranges.push(Decoration.mark({ class: "pm-time pm-time--markdown pm-time--" + TIME_KIND[match[1]] })
          .range(start, end));
        const duration = match[4];
        if (duration) {
          const opening = from + match[0].lastIndexOf(duration);
          const closing = opening + duration.length - 1;
          if (duration.startsWith("（")) ranges.push(durationParen("(", opening));
          if (duration.endsWith("）")) ranges.push(durationParen(")", closing));
        }
      }
    }
  }
  return Decoration.set(ranges, true);
}

class InlineTaskState {
  constructor(view) {
    this.view = view;
    this.win = view.dom.ownerDocument.defaultView;
    this.attachStateMachine();
  }

  destroy() {
    const dom = this.view.contentDOM;
    dom.removeEventListener("mousedown", this.onCbDown, true);
    dom.removeEventListener("click", this.onCbClick, true);
    dom.removeEventListener("contextmenu", this.onCbContext, true);
  }

  static STATE_SPAN = /\s*<span class="pm-time pm-time--(start|done|hold|cancel)"(?: data-pm-start="(\d{4}-\d{2}-\d{2} \d{2}:\d{2})")?>((?:<span[^>]*>[^<]*<\/span>|[^<])*)<\/span>/g;
  static STATE_LABEL = { start: "开始", done: "完成", hold: "搁置", cancel: "取消" };

  static stampTime(kind, previousStart, now, elapsed) {
    const time = kind === "start" && previousStart ? previousStart : taskTimestamp(now);
    const label = InlineTaskState.STATE_LABEL[kind];
    const resume = kind === "hold" && previousStart ? "（始于 @ " + previousStart + "）" : "";
    const duration = kind !== "start" && elapsed !== null ? " (耗时 " + formatElapsed(elapsed) + ")" : "";
    return label + " @ " + time + resume + duration;
  }

  static readState(text) {
    const marker = [...text.matchAll(InlineTaskState.STATE_SPAN)].at(-1);
    const plain = [...text.matchAll(TIME_MARKER)].findLast(match => match[1] !== "计划");
    const current = plain ? TIME_KIND[plain[1]] : marker?.[1] ||
      (/^\s*(?:[-*+]|\d+\.)\s+\[[xX]\]/.test(text) ? "done" : "todo");
    const previousStart = plain
      ? (current === "start" ? plain[2] : plain[3])
      : current === "start"
        ? marker[3].match(/(?:^|>)@?\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2})(?:<\/span>)?$/)?.[1]
        : marker?.[2];
    const clock = TASK_CLOCK.exec(text);
    const startedAt = Number(clock?.[3]) ||
      (previousStart ? Date.parse(previousStart.replace(" ", "T")) : 0) || 0;
    const automaticState = current === clock?.[4] ? current : "";
    return { current, previousStart, startedAt, automaticState };
  }

  // Keep the plan marker and replace only this line's current status marker.
  static lineWithState(line, current, next, previousStart, now, {
    keepCompletedClock = false, automaticState = "", pauseTodoClock = false,
  } = {}) {
    const checked = next !== "todo";
    const savedClock = TASK_CLOCK.exec(line.text);
    const segment = savedClock ? Number(savedClock[1]) : 0;
    const accumulated = savedClock ? Number(savedClock[2]) : 0;
    const knownStart = Number(savedClock?.[3]) ||
      (previousStart ? Date.parse(previousStart.replace(" ", "T")) : 0) || 0;
    const startedAt = knownStart || (current === "start" && segment) || (next === "start" ? now : 0);
    // A completed interval counts if the task resumes. An explicit hold has no running segment.
    const elapsed = accumulated + (segment ? Math.max(0, now - segment) :
      !savedClock && knownStart && current !== "hold" && current !== "cancel" ? Math.max(0, now - knownStart) : 0);
    let text = line.text.replace(TASK_CLOCK, "").replace(InlineTaskState.STATE_SPAN, "")
      .replace(TIME_MARKER, (marker, label) => label === "计划" ? marker : "")
      .replace(LEGACY_PLAN, marker => {
        const time = marker.replace(/<[^>]+>/g, "").replace(/^(?:计划|待办)?\s*@?\s*/, "");
        return "计划 @ " + time;
      }).replace(
      /^(\s*(?:[-*+]|\d+\.)\s+)\[(?: |x|X)\]/,
      "$1[" + (checked ? "x" : " ") + "]"
    );
    if (checked) {
      const clockAt = next === "start" || next === "done" ? now : 0;
      const clock = startedAt || next === "hold" || automaticState
        ? " %%dotpm-clock:" + clockAt + "," + elapsed + "," + startedAt + (automaticState ? ",auto-" + automaticState : "") + "%%"
        : "";
      const marker = InlineTaskState.stampTime(next, startedAt ? taskTimestamp(startedAt) : null, now,
        savedClock || knownStart || next === "hold" ? elapsed : null);
      text = text.trimEnd() + clock + " " + marker + " ";
    } else if (pauseTodoClock && startedAt) {
      text = text.trimEnd() + " %%dotpm-clock:0," + elapsed + "," + startedAt + "%% ";
    } else if (keepCompletedClock && startedAt && savedClock) {
      text = text.trimEnd() + savedClock[0].replace(/,auto-(?:cancel|hold)%%$/, "%%") + " ";
    }
    return text;
  }

  static taskTree(doc, tabSize, { firstLine = 1, readTask = text =>
    TASK_LINE.test(text) ? InlineTaskState.readState(text) : null } = {}) {
    const stack = [];
    const tasks = new Map();
    let fence = null;
    for (let number = firstLine; number <= doc.lines; number++) {
      const item = doc.line(number);
      const text = item.text;
      const fenceMarker = /^\s*([~]{3,}|[`]{3,})/.exec(text)?.[1];
      if (fence) {
        if (fenceMarker?.[0] === fence[0] && fenceMarker.length >= fence.length) fence = null;
        continue;
      }
      if (fenceMarker) {
        fence = fenceMarker;
        continue;
      }
      if (!text.trim()) continue;

      const [, whitespace, prefix] = /^(\s*)((?:[-*+]|\d+[.)])\s+)/.exec(text) || /^(\s*)/.exec(text);
      let indent = 0;
      for (const char of whitespace) {
        indent += char === "\t" ? tabSize - indent % tabSize : 1;
      }
      while (stack.length && indent < stack.at(-1).contentIndent) stack.pop();
      if (!prefix) continue;

      const parent = stack.at(-1);
      const task = readTask(text);
      const node = { line: item, parent, task, children: [], contentIndent: indent + prefix.length };
      parent?.children.push(node);
      stack.push(node);
      if (task) tasks.set(number, node);
    }

    return tasks;
  }

  static collectParents(parent, affected) {
    for (; parent; parent = parent.parent) {
      if (!parent.task) continue;
      if (affected.has(parent) || InlineTaskState.hasManualOverride(parent.task)) break;
      affected.add(parent);
    }
  }

  static hasManualOverride({ current, automaticState }) {
    return (current === "hold" || current === "cancel") && !automaticState;
  }

  static deriveParentText(parent, now, restore = false) {
    const { line, task } = parent;
    if (!TASK_LINE.test(line.text) || (!restore && InlineTaskState.hasManualOverride(task))) return null;
    const children = taskChildren(parent);
    if (!children.length) return null;
    const { next, allTodo } = aggregateChildrenState(children);
    const { current, startedAt, automaticState } = task;
    const clock = TASK_CLOCK.exec(line.text);
    const automatic = next === "cancel" || next === "hold" ? next : "";
    if (next === current) {
      if (allTodo && clock) return line.text.replace(TASK_CLOCK, "").trimEnd();
      if (!restore || automatic === automaticState) return null;
      // Release the manual override without rewriting its timestamp or elapsed time.
      if (!clock) return line.text.trimEnd() + " %%dotpm-clock:0,0,0,auto-" + automatic + "%% ";
      const suffix = (clock[3] === undefined ? ",0" : "") + ",auto-" + automatic + "%%";
      return line.text.replace(TASK_CLOCK, clock[0].replace(/%%$/, suffix));
    }
    let original = startedAt;
    if (!original && (restore || current !== "todo")) {
      for (const child of children) {
        const start = child.task.startedAt;
        if (child.task.current !== "todo" && start && (!original || start < original)) original = start;
      }
    }
    const insert = InlineTaskState.lineWithState(line, current, next,
      original ? taskTimestamp(original) : null, now, {
        automaticState: automatic,
        keepCompletedClock: next === "todo" && !allTodo && current === "done",
        pauseTodoClock: next === "todo" && !allTodo && (current !== "done" || !clock),
      });
    return next === "todo" ? insert.trimEnd() : insert;
  }

  static reconcileParents(affected, now) {
    const changes = [];
    for (const parent of [...affected].sort((a, b) => b.line.number - a.line.number)) {
      const insert = InlineTaskState.deriveParentText(parent, now);
      if (insert === null) continue;
      parent.task = InlineTaskState.readState(insert);
      changes.push({ from: parent.line.from, to: parent.line.to, insert });
    }
    return changes.reverse();
  }

  setLineState(line, current, next, previousStart) {
    const now = Date.now();
    const text = InlineTaskState.lineWithState(line, current, next, previousStart, now, { keepCompletedClock: current === "done" });
    this.applyLineText(line, text, now);
  }

  applyLineText(line, text, now) {
    const { doc, tabSize } = this.view.state;
    const changed = InlineTaskState.taskTree(doc, tabSize, { readTask: readProgressTask }).get(line.number);
    const nextTask = InlineTaskState.readState(text);
    const affected = new Set();
    if (changed) {
      changed.task = nextTask;
      InlineTaskState.collectParents(changed.parent, affected);
    }
    const changes = InlineTaskState.reconcileParents(affected, now);
    const offset = changes.reduce((sum, change) => sum + change.insert.length - (change.to - change.from), 0);
    changes.push({ from: line.from, to: line.to, insert: text });
    this.view.dispatch({
      changes,
      selection: nextTask.current !== "todo" ? { anchor: line.from + offset + text.length } : undefined,
      userEvent: "input.time",
    });
  }

  openParentMenu(button) {
    if (this.view.state.readOnly) return;
    const number = this.lineOfEventTarget(button);
    if (!this.progress?.children.has(number)) return;

    const parentNode = () => {
      if (!button.isConnected) return null;
      const lineNo = this.lineOfEventTarget(button);
      if (!this.progress?.children.has(lineNo)) return null;
      const { doc, tabSize } = this.view.state;
      return InlineTaskState.taskTree(doc, tabSize, { readTask: readProgressTask }).get(lineNo);
    };
    const parent = parentNode();
    if (!parent) return;

    const apply = action => {
      const node = parentNode();
      if (!node) return;
      const { current, previousStart } = node.task;
      if (action !== "restore") {
        if (current !== action) this.setLineState(node.line, current, action, previousStart);
        return;
      }
      if (current !== "hold" && current !== "cancel") return;

      const now = Date.now();
      const text = InlineTaskState.deriveParentText(node, now, true);
      if (text !== null) this.applyLineText(node.line, text, now);
    };

    const menu = new Menu();
    const current = parent.task.current;
    if (current === "hold" || current === "cancel") {
      menu.addItem(item => item.setTitle("恢复父项").setIcon("play").onClick(() => apply("restore")));
    }
    if (current !== "hold" && current !== "cancel") {
      menu.addItem(item => item.setTitle("搁置父项").setIcon("play").onClick(() => apply("hold")));
    }
    if (current !== "cancel") {
      menu.addItem(item => item.setTitle("取消父项").setIcon("x").onClick(() => apply("cancel")));
    }
    const rect = button.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom });
  }

  lineOfEventTarget(target) {
    try {
      const lineEl = target.closest(".cm-line");
      if (!lineEl) return null;
      const pos = this.view.posAtDOM(lineEl, 0);
      return this.view.state.doc.lineAt(pos).number;
    } catch (e) {
      return null;
    }
  }

  // 左键可从搁置恢复，右键继续处理搁置与取消。
  handleCheckbox(ev, rightClick) {
    const lineNo = this.lineOfEventTarget(ev.target);
    if (!lineNo || this.progress?.children.has(lineNo)) return;
    const line = this.view.state.doc.line(lineNo);
    if (!TASK_LINE.test(line.text)) return;
    const { current: cur, previousStart } = InlineTaskState.readState(line.text);
    let next;
    if (rightClick) {
      next = cur === "hold" ? "cancel" : cur === "cancel" ? "todo" : "hold";
    } else {
      next = cur === "todo" || cur === "hold" ? "start" : cur === "start" ? "done" : "todo";
    }
    this.setLineState(line, cur, next, previousStart);
    const checkbox = ev.target.closest(".cm-line")?.querySelector("input.task-list-item-checkbox");
    // A cancelled browser click can restore the old checked property on a reused widget.
    this.win.setTimeout(() => {
      if (checkbox?.isConnected) checkbox.checked = checkbox.dataset.task?.toLowerCase() === "x";
    }, 0);
  }

  attachStateMachine() {
    const dom = this.view.contentDOM;
    const hitsCheckbox = (event) => {
      if (!event.target?.matches?.("input.task-list-item-checkbox")) return false;
      const lineNo = this.lineOfEventTarget(event.target);
      return lineNo !== null && TASK_LINE.test(this.view.state.doc.line(lineNo).text);
    };
    this.onCbDown = (ev) => {
      if (!hitsCheckbox(ev) || (ev.button !== 0 && ev.button !== 2)) return;
      ev.preventDefault();
      ev.stopPropagation();
    };
    this.onCbClick = (ev) => {
      if (!hitsCheckbox(ev)) {
        // Prevent a click on the surrounding label from activating its checkbox.
        if (ev.target?.closest?.("label.task-list-label")) ev.preventDefault();
        return;
      }
      if (ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      this.handleCheckbox(ev, false);
    };
    this.onCbContext = (ev) => {
      if (!hitsCheckbox(ev) || ev.button !== 2) return;
      ev.preventDefault();
      ev.stopPropagation();
      this.handleCheckbox(ev, true);
    };
    dom.addEventListener("mousedown", this.onCbDown, true);
    dom.addEventListener("click", this.onCbClick, true);
    dom.addEventListener("contextmenu", this.onCbContext, true);
  }
}

function isBlankTask(text) {
  return /^\s*(?:[-*+]|\d+[.)])\s+\[ \]\s*$/.test(text);
}

function taskChildren(parent) {
  const children = [];
  const pending = [...parent.children];
  while (pending.length) {
    const child = pending.pop();
    if (!child.task) pending.push(...child.children);
    else if (!isBlankTask(child.line.text)) children.push(child);
  }
  return children;
}

function aggregateChildrenState(children) {
  return aggregateTaskStates(children.map(child => child.task.current));
}

function aggregateTaskStates(children) {
  const states = new Set(children);
  const allTodo = states.size === 1 && states.has("todo");
  if (states.size === 1) return { next: states.values().next().value, allTodo };
  const next = states.size === 2 && states.has("todo") && states.has("cancel") ? "todo" : "start";
  return { next, allTodo };
}

function taskParent(node) {
  let parent = node.parent;
  while (parent && !parent.task) parent = parent.parent;
  return parent;
}

function readProgressTask(text) {
  const marker = /^\s*(?:[-*+]|\d+[.)])\s+\[([^\]\r\n])\](?=[ \t]|$)/.exec(text)?.[1];
  if (marker === undefined) return null;
  if (TASK_LINE.test(text)) return InlineTaskState.readState(text);
  if (/^[c~]$/i.test(marker)) return { current: "cancel" };
  return { current: /^[x]$/i.test(marker) ? "done" : "todo" };
}

function calculateTaskProgress(doc, tabSize) {
  const yaml = doc.line(1).text === "---" ? getFrontMatterInfo(doc.toString()) : null;
  const firstLine = yaml?.exists ? doc.lineAt(Math.min(yaml.contentStart, doc.length)).number : 1;
  const tasks = InlineTaskState.taskTree(doc, tabSize, { firstLine, readTask: readProgressTask });
  const children = new Map();
  let closed = 0;
  for (const [number, node] of [...tasks].reverse()) {
    const finished = node.task.current === "done" || node.task.current === "cancel";
    closed += Number(finished);
    const parent = taskParent(node);
    if (!parent) continue;
    const count = children.get(parent.line.number) || { closed: 0, total: 0 };
    const nested = children.get(number);
    count.closed += Number(finished) + (nested?.closed || 0);
    count.total += 1 + (nested?.total || 0);
    children.set(parent.line.number, count);
  }
  return { children, closed, total: tasks.size };
}

function progressPercent(closed, total) {
  return total ? Math.round(closed * 100 / total) : 0;
}

class TaskProgressWidget extends WidgetType {
  constructor(label, { closed, total }, tasks) {
    super();
    this.tasks = tasks;
    this.label = label;
    this.closed = closed;
    this.total = total;
  }

  eq(other) {
    return this.tasks === other.tasks && this.label === other.label &&
      this.closed === other.closed && this.total === other.total;
  }

  toDOM(view) {
    const doc = view.dom.ownerDocument;
    const badge = doc.createElement("span");
    const percent = progressPercent(this.closed, this.total);
    badge.className = "dotpm-task-progress";
    badge.dataset.scope = this.label;
    badge.title = this.label + "已完成或取消 " + this.closed + "/" + this.total + "（" + percent + "%）";
    const bar = doc.createElement("span");
    bar.className = "dotpm-task-progress-track";
    bar.style.setProperty("--dotpm-task-progress", percent + "%");
    bar.setAttribute("aria-hidden", "true");
    const summary = doc.createElement("span");
    summary.className = "dotpm-task-progress-summary";
    summary.append(bar, this.label + " " + this.closed + "/" + this.total + " · " + percent + "%");
    badge.appendChild(summary);
    if (this.tasks && !view.state.readOnly) {
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "dotpm-parent-task-menu";
      button.textContent = "⋯";
      button.title = "父项操作";
      button.setAttribute("aria-label", "父项操作");
      button.setAttribute("aria-haspopup", "menu");
      button.addEventListener("mousedown", event => event.preventDefault());
      button.addEventListener("click", event => {
        event.stopPropagation();
        this.tasks.openParentMenu(button);
      });
      badge.appendChild(button);
    }
    return badge;
  }
}

const PROGRESS_YAML = /^((?:progress|"progress"|'progress')[ \t]*:)(?:([ \t]+)(?:[-+]?\d+(?:\.\d+)?|["']\d+(?:\.\d+)?["']|null|~))?([ \t]*(?:#[^\r\n]*)?)(?=\r?$)/m;

function updateSavedTaskProgress(source, tabSize, hadTasks) {
  const yaml = getFrontMatterInfo(source);
  if (!yaml.exists) return source;
  const header = source.slice(0, yaml.contentStart);
  if (!PROGRESS_YAML.test(header)) return source;
  const body = source.slice(yaml.contentStart);
  const { closed, total } = calculateTaskProgress(Text.of(body.split(/\r?\n/)), tabSize);
  if (!total && !hadTasks) return source;
  return header.replace(PROGRESS_YAML, (_match, key, spacing, comment) =>
    key + (spacing || " ") + progressPercent(closed, total) + (comment.startsWith("#") ? " " : "") + comment) + body;
}

function taskLineStructure(text) {
  const fence = /^\s*([~]{3,}|[`]{3,})/.exec(text)?.[1];
  if (fence) return fence;
  const prefix = /^(\s*(?:[-*+]|\d+[.)])\s+)/.exec(text)?.[1];
  if (!prefix) return "";
  const task = readProgressTask(text);
  if (!task) return prefix;
  const blank = isBlankTask(text);
  return prefix + "/" + task.current + "/" + (task.automaticState || "") + "/" + blank;
}

const reconcileEditedTasks = EditorState.transactionFilter.of(transaction => {
  const userEdit = ["input", "insert", "delete", "move"].some(event => transaction.isUserEvent(event));
  if (!transaction.docChanged || !userEdit || transaction.isUserEvent("input.time")) {
    return transaction;
  }
  const { doc: previous, tabSize } = transaction.startState;
  const doc = transaction.newDoc;
  let structureChanged = false;
  transaction.changes.iterChangedRanges((oldFrom, oldTo, from, to) => {
    const oldLine = previous.lineAt(oldFrom);
    const newLine = doc.lineAt(from);
    if (oldTo > oldLine.to || to > newLine.to || taskLineStructure(oldLine.text) !== taskLineStructure(newLine.text)) {
      structureChanged = true;
    }
  });
  if (!structureChanged) return transaction;

  const before = InlineTaskState.taskTree(previous, tabSize, { readTask: readProgressTask });
  const after = InlineTaskState.taskTree(doc, tabSize, { readTask: readProgressTask });
  const checkboxEnd = node => node.line.from + node.line.text.indexOf("]");
  const newByPosition = new Map([...after.values()].map(node => [checkboxEnd(node), node]));
  const oldToNew = new Map();
  for (const node of before.values()) {
    const position = transaction.changes.mapPos(checkboxEnd(node), 1, MapMode.TrackAfter);
    const replacement = newByPosition.get(position);
    if (replacement) oldToNew.set(node, replacement);
  }

  const affected = new Set();
  const matched = new Set(oldToNew.values());
  for (const node of before.values()) {
    const oldParent = taskParent(node);
    const newParent = oldToNew.get(oldParent);
    const replacement = oldToNew.get(node);
    const replacementParent = replacement && taskParent(replacement);
    const wasChild = !isBlankTask(node.line.text);
    const isChild = replacement && !isBlankTask(replacement.line.text);
    if (replacement && wasChild === isChild && newParent === (replacementParent || undefined) &&
        node.task.current === replacement.task.current && node.task.automaticState === replacement.task.automaticState) continue;
    if (wasChild) {
      let ancestor = oldParent;
      while (ancestor && !oldToNew.has(ancestor)) ancestor = taskParent(ancestor);
      InlineTaskState.collectParents(oldToNew.get(ancestor), affected);
    }
    if (isChild) InlineTaskState.collectParents(replacementParent, affected);
  }
  for (const node of after.values()) {
    if (!matched.has(node) && !isBlankTask(node.line.text)) InlineTaskState.collectParents(taskParent(node), affected);
  }
  const changes = InlineTaskState.reconcileParents(affected, Date.now());
  return changes.length ? [transaction, { changes, sequential: true }] : transaction;
});

const skipHiddenTaskClock = EditorState.transactionFilter.of(transaction => {
  if (transaction.docChanged || !transaction.selection || !transaction.isUserEvent("select") ||
      transaction.isUserEvent("select.pointer")) return transaction;

  const { doc, selection: previous } = transaction.startState;
  const selection = transaction.newSelection;
  let changed = false;
  const ranges = selection.ranges.map((range, index) => {
    const line = doc.lineAt(range.head);
    const clock = TASK_LINE.test(line.text) && TASK_CLOCK.exec(line.text);
    if (!clock) return range;

    const from = line.from + clock.index;
    const to = from + clock[0].length;
    if (range.head <= from || range.head >= to) return range;

    const prior = previous.ranges.length === selection.ranges.length ? previous.ranges[index].head : range.head;
    const forward = prior >= line.from && prior <= line.to && prior !== range.head
      ? prior < range.head
      : range.head - from > to - range.head;
    let head = forward ? to : from;
    // A zero-width replacement has no visible caret stop between its two edges.
    if (prior === (forward ? from : to)) {
      head = forward && head === line.to && head < doc.length
        ? head + 1
        : line.from + findClusterBreak(line.text, head - line.from, forward);
    }
    changed = true;
    return range.empty
      ? EditorSelection.cursor(head, range.assoc, range.bidiLevel, range.goalColumn)
      : EditorSelection.range(range.anchor, head, range.goalColumn, range.bidiLevel, range.assoc);
  });

  if (!changed) return transaction;
  return [transaction, { selection: EditorSelection.create(ranges, selection.mainIndex), sequential: true }];
});

function taskSelectionRanges(doc, from, to) {
  const ranges = [];
  let start = from;
  const lastLine = doc.lineAt(to).number;
  for (let number = doc.lineAt(from).number; number <= lastLine; number++) {
    const line = doc.line(number);
    const clock = TASK_LINE.test(line.text) && TASK_CLOCK.exec(line.text);
    if (!clock) continue;

    const clockFrom = line.from + clock.index;
    const clockEnd = clock.index + clock[0].length;
    const clockTo = line.from + clockEnd;
    const suffix = line.text.slice(clockEnd).trimEnd();
    const visibleEnd = suffix ? clockTo + suffix.length :
      line.from + line.text.slice(0, clock.index).trimEnd().length;

    if (from <= line.from && to >= visibleEnd) {
      // The clock may sit after all visible text in a reopened task.
      to = Math.max(to, line.to);
    } else if (start < clockTo && to > clockFrom) {
      if (start < clockFrom) ranges.push({ from: start, to: clockFrom });
      start = clockTo;
    }
  }
  if (start < to) ranges.push({ from: start, to });
  return ranges;
}

const deletePastHiddenTaskClock = EditorState.transactionFilter.of(transaction => {
  const backward = transaction.isUserEvent("delete.backward");
  const deletingSelection = transaction.isUserEvent("delete.selection");
  if (!transaction.docChanged || (!deletingSelection && transaction.effects.length) ||
      (!deletingSelection && !backward && !transaction.isUserEvent("delete.forward"))) return transaction;

  const { doc, selection } = transaction.startState;

  const changes = [];
  let redirected = false;
  let onlyDeletes = true;
  transaction.changes.iterChanges((from, to, _fromB, _toB, insert) => {
    if (insert.length) onlyDeletes = false;
    if (deletingSelection) {
      const ranges = taskSelectionRanges(doc, from, to);
      redirected ||= ranges.length !== 1 || ranges[0].from !== from || ranges[0].to !== to;
      changes.push(...ranges);
      return;
    }
    const line = doc.lineAt(backward ? to : from);
    const clock = TASK_LINE.test(line.text) && TASK_CLOCK.exec(line.text);
    if (clock) {
      const clockFrom = line.from + clock.index;
      const clockTo = clockFrom + clock[0].length;
      if (from >= clockFrom && to <= clockTo) {
        redirected = true;
        if (backward) {
          from = line.from + findClusterBreak(line.text, clock.index, false);
          to = clockFrom;
        } else {
          from = clockTo;
          to = clockTo === line.to ? Math.min(clockTo + 1, doc.length) :
            line.from + findClusterBreak(line.text, clockTo - line.from, true);
        }
      }
    }
    if (from < to) changes.push({ from, to });
  });
  if (!redirected || !onlyDeletes) return transaction;

  // Two cursors can redirect to the same visible character.
  const merged = [];
  for (const change of changes.sort((a, b) => a.from - b.from)) {
    const last = merged.at(-1);
    if (last && change.from <= last.to) last.to = Math.max(last.to, change.to);
    else merged.push(change);
  }
  const changeSet = transaction.startState.changes(merged);
  return {
    changes: changeSet,
    effects: StateEffect.mapEffects(transaction.effects, transaction.changes.invertedDesc.composeDesc(changeSet.desc)),
    selection: deletingSelection ? EditorSelection.create(selection.ranges.map(range =>
      EditorSelection.cursor(changeSet.mapPos(range.from, -1))), selection.mainIndex) : undefined,
    userEvent: transaction.annotation(Transaction.userEvent),
    scrollIntoView: transaction.scrollIntoView,
  };
});

function writeTaskSelectionToClipboard(event, view) {
  const { state } = view;
  const cutting = event.type === "cut";
  if (!event.clipboardData || (cutting && state.readOnly)) return false;

  const { doc, selection } = state;
  const groups = [];
  let adjusted = false;
  for (const { from, to } of selection.ranges) {
    if (from === to) continue;
    const ranges = taskSelectionRanges(doc, from, to);
    adjusted ||= ranges.length !== 1 || ranges[0].from !== from || ranges[0].to !== to;
    groups.push(ranges);
  }
  if (!adjusted) return false;

  const text = groups.filter(ranges => ranges.length).map(ranges =>
    ranges.map(({ from, to }) => state.sliceDoc(from, to)).join("")).join(state.lineBreak);
  event.clipboardData.setData("text/plain", text);
  event.preventDefault();
  if (cutting) {
    const changes = state.changes(groups.flat());
    if (!changes.empty) {
      view.dispatch({
        changes,
        selection: EditorSelection.create(selection.ranges.map(range =>
          EditorSelection.cursor(changes.mapPos(range.from, -1))), selection.mainIndex),
        scrollIntoView: true,
        userEvent: "delete.cut",
      });
    }
  }
  return true;
}

const taskSelectionClipboard = Prec.high(EditorView.domEventHandlers({
  copy: writeTaskSelectionToClipboard,
  cut: writeTaskSelectionToClipboard,
}));

function createInlineTimeExtension(plugin) {
  return ViewPlugin.fromClass(class {
    constructor(view) {
      this.tasks = new InlineTaskState(view);
      this.updateProgress(view);
      this.compact = usesCompactTime(view);
      this.decorations = timeDecorations(view, plugin.settings, this.tasks, this.compact);
      plugin.inlineTimeViews.add(view);
    }
    destroy() {
      plugin.inlineTimeViews.delete(this.tasks.view);
      this.tasks.destroy();
    }
    updateProgress(view) {
      this.progress = this.tasks.progress = calculateTaskProgress(view.state.doc, view.state.tabSize);
      const section = view.dom.closest(SECTION_SEL);
      plugin.live2Bindings?.get(section)?.updateTaskProgress(this.progress);
    }
    update(update) {
      const refresh = update.transactions.some(transaction =>
        transaction.effects.some(effect => effect.is(refreshInlineTime))
      );
      if (update.docChanged || update.startState.tabSize !== update.state.tabSize) {
        this.updateProgress(update.view);
      }
      const compact = usesCompactTime(update.view);
      if (update.docChanged || update.viewportChanged || update.startState.tabSize !== update.state.tabSize || refresh ||
          compact !== this.compact || (update.selectionSet && compact)) {
        this.compact = compact;
        this.decorations = timeDecorations(update.view, plugin.settings, this.tasks, compact);
      }
    }
  }, { decorations: extension => extension.decorations });
}

const DEFAULT_SETTINGS = {
  enabled: true,
  highContrastPalette: true,
  showRunningTime: false,
  runningTimeRefreshSeconds: 60,
  mode: "preview", // preview = 源码+实时预览；live = 嵌入 Obsidian 原生 Live Preview 编辑器
  layout: "side", // side | below
  maxHeight: 260,
  descriptionHeight: null,
  descriptionWidth: null,
  showBadge: true,
};

const LINKED_NOTES_PROPERTY = "projectm-linked-notes";
const LINKED_ROLLUP_PROPERTY = "projectm-linked-rollups";

function linkedNoteRecords(frontmatter) {
  const records = frontmatter?.[LINKED_NOTES_PROPERTY];
  return Array.isArray(records) ? records.filter(record =>
    typeof record?.id === "string" && typeof record.note === "string") : [];
}

function linkedNotePath(link) {
  return link.startsWith("[[") && link.endsWith("]]") ? link.slice(2, -2) : "";
}

function linkedRollupParents(project, records, prior = {}) {
  const parents = new Map();
  function addAncestors(parentId, active) {
    const chain = [];
    const seen = new Set();
    while (parentId && !seen.has(parentId)) {
      const node = project.taskIndex.get(parentId);
      if (!node) break;
      seen.add(parentId);
      chain.push(node);
      parentId = node.parentId;
    }
    chain.reverse().forEach(({ task }, depth) => {
      const parent = parents.get(task.id) || { task, depth, records: [], active: false };
      parent.active ||= active;
      parents.set(task.id, parent);
    });
  }
  for (const record of records) {
    if (!project.taskIndex.has(record.parentId)) continue;
    addAncestors(record.parentId, true);
    parents.get(record.parentId).records.push(record);
  }
  for (const id of Object.keys(prior)) if (!parents.has(id)) addAncestors(id, false);
  return parents;
}

function linkedStatusRules(statuses) {
  const definitions = new Map(statuses.map(status => [status.id, status]));
  const kind = id => {
    const status = definitions.get(id);
    const label = status?.label || "";
    if (/^cancel(?:led|ed)?$/i.test(id) || /取消/.test(label)) return "cancel";
    if (/^(blocked|hold|paused)$/i.test(id) || /搁置|暂停/.test(label)) return "hold";
    if (status?.complete || id === "done") return "done";
    if (/^(in-progress|doing|start)$/i.test(id) || /进行中/.test(label)) return "start";
    return "todo";
  };
  const idFor = wanted => statuses.find(status => kind(status.id) === wanted)?.id;
  return { kind, idFor };
}

function linkedChildStats(parent, kind) {
  const children = [...(parent.task.subtasks || []), ...parent.records];
  const states = children.map(child => kind(child.status));
  return {
    states, total: states.length,
    closed: states.filter(state => state === "done" || state === "cancel").length,
  };
}

class LinkedNotePicker extends FuzzySuggestModal {
  constructor(app, onChoose) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder("搜索现有笔记");
  }

  getItems() {
    return this.app.vault.getMarkdownFiles().filter(file => {
      const properties = this.app.metadataCache.getFileCache(file)?.frontmatter;
      return !properties?.["pm-project"] && !properties?.["pm-task"];
    });
  }

  getItemText(file) {
    return file.path;
  }

  onChooseItem(file) {
    this.onChoose(file);
  }
}

class LinkedNotesTable {
  constructor(app, view, collapsed) {
    this.app = app;
    this.view = view;
    this.subview = view.subview;
    this.state = this.subview.state;
    this.body = this.state.tableBody;
    this.wrapper = this.state.wrapper;
    this.project = view.project;
    this.file = app.vault.getFileByPath(this.project.filePath);
    this.collapsed = collapsed;
    this.win = this.body.ownerDocument.defaultView;
    this.observer = new MutationObserver(mutations => {
      if (mutations.some(change => [...change.addedNodes, ...change.removedNodes]
        .some(node => !node.matches?.(".pm-tree-drop-gap")))) this.render();
    });
    this.observer.observe(this.body, { childList: true });
    this.onScroll = () => {
      if (this.frame) return;
      this.frame = this.win.requestAnimationFrame(() => {
        this.frame = 0;
        if (this.state.rowDrag?.isPreviewing?.()) return;
        if (!this.rowCount) return;
        const offset = Math.max(0, this.wrapper.scrollTop - (this.body.previousElementSibling?.offsetHeight || 0));
        const start = Math.max(0, Math.floor(offset / this.state.rowHeight) - 8);
        const end = Math.min(this.rowCount, Math.ceil((offset + (this.wrapper.clientHeight || 600)) / this.state.rowHeight) + 8);
        if (start !== this.state.windowStart || end !== this.state.windowEnd) this.render();
      });
    };
    this.wrapper.addEventListener("scroll", this.onScroll);
    this.render();
    if (view.projectScope.spec.kind === "project") this.initializeRollups();
  }

  records() {
    return this.project.linkedNotes ?? linkedNoteRecords(this.app.metadataCache.getFileCache(this.file)?.frontmatter);
  }

  statuses() {
    return this.subview.scope.config.statuses;
  }

  initializeRollups() {
    const properties = this.app.metadataCache.getFileCache(this.file)?.frontmatter;
    const prior = properties?.[LINKED_ROLLUP_PROPERTY] || {};
    const needsRollup = [...linkedRollupParents(this.project, linkedNoteRecords(properties)).keys()]
      .some(id => !Object.hasOwn(prior, id));
    if (!needsRollup) return;
    this.subview.plugin.store.saveProject(this.project).catch(error =>
      console.error("[dotpm-live-desc] Could not initialize linked-note progress", error));
  }

  async changeRecords(update, owner = this.project) {
    try {
      const store = this.subview.plugin.store;
      if (typeof store.updateLinkedNotes === "function") {
        const project = await store.loadProjectByPath(owner.filePath);
        if (!project) return false;
        await store.updateLinkedNotes(project, update);
        return true;
      }
      await store.queue(this.file.path, async () => {
        store.markSelfWrite(this.file.path);
        await this.app.fileManager.processFrontMatter(this.file, properties => {
          const records = update(linkedNoteRecords(properties));
          if (records.length) properties[LINKED_NOTES_PROPERTY] = records;
          else delete properties[LINKED_NOTES_PROPERTY];
        });
        const project = await store.loadProjectByPath(this.file.path);
        if (project) await store.doSaveProject(project);
      });
      return true;
    } catch (error) {
      console.error("[dotpm-live-desc] Could not update linked notes", error);
      new Notice("无法保存关联笔记。");
      return false;
    }
  }

  chooseGroup(title, options, saveLabel, apply) {
    const modal = new Modal(this.app);
    modal.setTitle(title);
    const form = modal.contentEl.createEl("form");
    let groupId = options.currentId;
    new Setting(form).setName("分组").addDropdown(dropdown => {
      dropdown.addOption("", "未分组");
      for (const group of options.groups) dropdown.addOption(group.id, group.name);
      dropdown.setValue(groupId ?? "").onChange(value => { groupId = value || null; });
    });
    const actions = form.createDiv("modal-button-container");
    actions.createEl("button", { text: "取消", type: "button" }).addEventListener("click", () => modal.close());
    const save = actions.createEl("button", { text: saveLabel, type: "submit", cls: "mod-cta" });
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (save.disabled) return;
      save.disabled = true;
      try {
        if (await apply(groupId)) modal.close();
      } catch (error) {
        console.error("[dotpm-live-desc] Could not update linked note group", error);
        new Notice(error instanceof Error ? error.message : "无法保存关联笔记分组。");
      } finally {
        save.disabled = false;
      }
    });
    modal.open();
  }

  chooseNote(parentId = null) {
    new LinkedNotePicker(this.app, file => {
      const statuses = this.statuses();
      const value = this.app.metadataCache.getFileCache(file)?.frontmatter?.["进度状态"];
      const values = (Array.isArray(value) ? value : [value]).map(item => String(item ?? "").trim());
      const completed = values.includes("已完成") &&
        (statuses.find(status => status.id === "done") || statuses.find(status => status.complete && status.id !== "cancelled"));
      const initial = statuses.find(status => values.includes(status.id) || values.includes(status.label)) || completed ||
        statuses.find(status => status.id === "todo") || statuses.find(status => !status.complete) || statuses[0];
      const note = "[[" + file.path + "]]";
      const proposedId = this.win.crypto.randomUUID();
      const associate = async groupId => {
        if (groupId && !this.subview.linkedNoteGroupOptions?.()?.groups.some(group => group.id === groupId)) {
          throw new Error("所选分组已删除，请重新选择。");
        }
        let recordId = proposedId;
        const saved = await this.changeRecords(records => {
          const existing = records.find(record => record.note === note && record.parentId === parentId);
          if (existing) {
            recordId = existing.id;
            return records;
          }
          return [...records, { id: recordId, note, parentId, status: initial?.id || "todo" }];
        });
        if (saved && !parentId && groupId !== undefined) await this.subview.setLinkedNoteGroup(recordId, groupId);
        return saved;
      };
      const existing = this.records().find(record => record.note === note && record.parentId === parentId);
      const options = this.subview.linkedNoteGroupOptions?.(existing?.id);
      if (!parentId && options?.groups.length) {
        this.chooseGroup("关联笔记 · " + file.basename, options, "关联", associate);
      } else {
        void associate(undefined);
      }
    }).open();
  }

  composeRows(nativeRows, records, collapsedIds, manualOrder, owner = this.project) {
    const query = this.state.query;
    if (!records.length || query?.text?.trim() || query?.filter?.conditions?.length) return nativeRows;
    const nativeIds = new Set(nativeRows.map(row => row.task.id));
    const linkedIds = new Set(records.map(record => "projectm-link:" + record.id));
    const linkedParents = new Map();
    const childOrder = new Map();
    for (const record of records) {
      const id = "projectm-link:" + record.id;
      const children = (record.childTaskIds || []).filter(taskId =>
        owner.taskIndex.get(taskId)?.parentId === null && !linkedParents.has(taskId) && linkedParents.set(taskId, id));
      childOrder.set(id, children);
    }
    const nativeByParent = new Map();
    for (const row of nativeRows) {
      const parent = linkedParents.get(row.task.id) ?? (nativeIds.has(row.parentId) ? row.parentId : null);
      if (!nativeByParent.has(parent)) nativeByParent.set(parent, []);
      nativeByParent.get(parent).push(row);
    }
    const byParent = new Map();
    for (const record of records) {
      const parent = linkedIds.has(record.parentId) || owner.taskIndex.has(record.parentId) ? record.parentId : null;
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push(record);
    }
    const rows = [];
    const visited = new Set();
    const visit = (parent, depth, guides) => {
      if (collapsedIds.has(parent) || this.collapsed.has(parent)) return;
      let natives = nativeByParent.get(parent) || [];
      if (manualOrder && childOrder.has(parent)) {
        const rank = new Map(childOrder.get(parent).map((id, index) => [id, index]));
        natives = [...natives].sort((a, b) => rank.get(a.task.id) - rank.get(b.task.id));
      }
      const notes = byParent.get(parent) || [];
      const anchored = new Map();
      const nativeSiblings = new Set(natives.map(row => row.task.id));
      for (const record of notes) {
        const anchor = manualOrder && nativeSiblings.has(record.beforeTaskId) ? record.beforeTaskId : null;
        if (!anchored.has(anchor)) anchored.set(anchor, []);
        anchored.get(anchor).push({ task: { id: "projectm-link:" + record.id }, record });
      }
      const siblings = natives.flatMap(row => [...(anchored.get(row.task.id) || []), row]);
      siblings.push(...(anchored.get(null) || []));
      siblings.forEach((row, index) => {
        if (visited.has(row.task.id)) return;
        visited.add(row.task.id);
        const isLastChild = index === siblings.length - 1;
        rows.push({ ...row, parentId: parent, depth, guides, isLastChild });
        const childGuides = guides.length ? [...guides.slice(0, -1), !isLastChild, false] : [false];
        visit(row.task.id, depth + 1, childGuides);
      });
    };
    visit(null, 0, []);
    return rows;
  }

  render(nativeRequested = false) {
    if (!this.body.isConnected || this.state.tableBody !== this.body || this.rendering) return;
    if (!nativeRequested && this.state.rowDrag?.isPreviewing?.()) return;
    this.mountToolbar();
    const original = this.state.renderWindow;
    if (original !== this.renderWindow) {
      this.nativeRenderWindow = original;
      this.renderWindow = () => this.render(true);
      this.state.renderWindow = this.renderWindow;
    }
    const ctx = this.subview.makeTableContext();
    const nativeRows = this.state.visibleRows;
    const records = this.records();
    const selection = this.state.selectedLinkedRowIds;
    if (selection?.size) {
      const ids = new Set(records.map(record => "projectm-link:" + record.id));
      for (const id of selection) if (!ids.has(id)) selection.delete(id);
    }
    const rollups = linkedRollupParents(this.project, records);
    const { kind } = linkedStatusRules(this.statuses());
    const subtree = ctx.scope.spec.kind === "subtree";
    const owners = new Map();
    let combined = nativeRows;
    if (subtree) {
      const buckets = new Map(ctx.scope.projects.map(project => [project, []]));
      for (const row of nativeRows) buckets.get(ctx.scope.projectOf(row.task.id))?.push(row);
      combined = ctx.scope.projects.flatMap(project => {
        const notes = project.linkedNotes ?? [];
        for (const note of notes) owners.set("projectm-link:" + note.id, project);
        return this.composeRows(buckets.get(project), notes, ctx.collapsedIds, ctx.manualOrder, project);
      });
    } else {
      combined = this.composeRows(nativeRows, records, ctx.collapsedIds, ctx.manualOrder);
    }
    const nativeGroupLayout = typeof this.state.windowLength === "number";
    const hasLinkedRows = combined !== nativeRows;
    this.rowCount = !nativeGroupLayout && hasLinkedRows ? combined.length : 0;
    if (nativeRequested || hasLinkedRows || this.hadLinkedRows) {
      this.rendering = true;
      // The native renderer skips IDs outside its project index, but still includes their space in the scroll window.
      this.state.visibleRows = combined;
      if (nativeGroupLayout) {
        this.state.renderLinkedRow = row => {
          const linkRow = this.makeLinkedRow(row, ctx.columns, owners.get(row.task.id) ?? this.project);
          if (!subtree) this.state.rowDrag?.attach(linkRow, row.task.id);
          return linkRow;
        };
      }
      try {
        this.nativeRenderWindow();
      } finally {
        this.state.visibleRows = nativeRows;
        if (nativeGroupLayout) this.state.renderLinkedRow = undefined;
        this.rendering = false;
      }
    }
    this.hadLinkedRows = hasLinkedRows;

    const rendered = new Map([...this.body.querySelectorAll("tr[data-task-id]")].map(row => [row.dataset.taskId, row]));
    const addRow = this.body.querySelector(".pm-table-add-row");
    let anchor = addRow?.previousElementSibling?.matches(".pm-table-spacer") ? addRow.previousElementSibling : addRow;
    for (const row of (nativeGroupLayout ? [] : combined.slice(this.state.windowStart, this.state.windowEnd).reverse())) {
      if (row.record) {
        const linkRow = this.makeLinkedRow(row, ctx.columns);
        this.state.rowDrag?.attach(linkRow, row.task.id);
        this.body.insertBefore(linkRow, anchor);
        anchor = linkRow;
      } else if (rendered.has(row.task.id)) {
        anchor = rendered.get(row.task.id);
      }
    }
    for (const [id, row] of rendered) {
      if (subtree) {
        const owner = ctx.scope.projectOf(id);
        const hasLinkedChildren = owner?.linkedNotes?.some(note => note.parentId === id);
        const expand = row.querySelector(".pm-table-cell-expand");
        if (hasLinkedChildren && expand && !expand.querySelector(".pm-collapse-toggle, .projectm-linked-control")) {
          expand.append(this.foldButton(id, "关联笔记"));
        }
        continue;
      }
      const title = row.querySelector(".pm-table-title-inner");
      title?.querySelector(".projectm-linked-count")?.remove();
      if (title && rollups.has(id)) {
        const { closed, total } = linkedChildStats(rollups.get(id), kind);
        const count = this.body.ownerDocument.createElement("span");
        count.className = "projectm-linked-label projectm-linked-count";
        count.textContent = "子任务 " + closed + "/" + total;
        title.append(count);
      }
      if (title && !title.querySelector(".projectm-linked-control")) {
        const button = this.button("关联笔记为子任务", () => this.chooseNote(id), "link");
        button.classList.add("pm-icon-btn", "pm-icon-btn--hover-only");
        title.append(button);
      }
      const expand = row.querySelector(".pm-table-cell-expand");
      const hasLinkedChildren = records.some(record => record.parentId === id);
      if (!hasLinkedChildren) expand?.querySelector(".projectm-linked-control")?.remove();
      if (expand && !expand.querySelector(".pm-collapse-toggle, .projectm-linked-control") && hasLinkedChildren) {
        expand.append(this.foldButton(id, "关联笔记"));
      }
    }
    this.observer.takeRecords();
  }

  foldButton(id, subject) {
    const collapsed = this.collapsed.has(id);
    const button = this.button((collapsed ? "展开" : "收起") + subject, () => {
      const closing = !this.collapsed.has(id);
      const render = () => {
        if (closing) this.collapsed.add(id);
        else this.collapsed.delete(id);
        this.render(true);
      };
      if (typeof this.subview.animateLinkedFold === "function") {
        void this.subview.animateLinkedFold(id, closing, render).catch(error =>
          console.error("[dotpm-live-desc] Could not animate linked rows", error));
      } else {
        render();
      }
    }, collapsed ? "chevron-right" : "chevron-down");
    button.classList.add("pm-linked-fold-toggle");
    button.setAttribute("aria-expanded", String(!collapsed));
    return button;
  }

  mountToolbar() {
    if (this.view.projectScope.spec.kind !== "project") return;
    const actions = this.view.headerEl?.querySelector(".pm-vh-actions");
    if (!actions || this.toolbarButton?.parentElement === actions) return;
    if (!this.toolbarButton) {
      const button = this.button("关联现有笔记", () => this.chooseNote());
      button.className = "pm-chip-btn projectm-linked-toolbar";
      const icon = button.ownerDocument.createElement("span");
      icon.className = "pm-chip-btn-icon";
      icon.setAttribute("aria-hidden", "true");
      setIcon(icon, "link");
      const label = button.ownerDocument.createElement("span");
      label.className = "pm-chip-btn-label";
      label.textContent = button.textContent;
      button.replaceChildren(icon, label);
      this.toolbarButton = button;
    }
    actions.prepend(this.toolbarButton);
  }

  button(label, onClick, icon) {
    const button = this.body.ownerDocument.createElement("button");
    button.type = "button";
    button.className = icon ? "projectm-linked-control clickable-icon" : "projectm-linked-control pm-prop-add";
    button.setAttribute("aria-label", label);
    if (icon) setIcon(button, icon);
    else button.textContent = label;
    button.addEventListener("click", event => {
      event.stopPropagation();
      onClick(event);
    });
    return button;
  }

  makeLinkedRow({ record, depth, guides, isLastChild }, columns, owner = this.project) {
    const doc = this.body.ownerDocument;
    const row = doc.createElement("tr");
    row.className = "pm-table-row projectm-linked-note-row";
    row.style.setProperty("--depth", depth);
    const selectCell = row.insertCell();
    selectCell.className = "pm-table-cell-select";
    const selection = this.state.selectedLinkedRowIds;
    if (this.view.projectScope.spec.kind === "project" && this.state.rowDrag && selection) {
      const id = "projectm-link:" + record.id;
      const checkbox = doc.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "pm-checkbox";
      checkbox.setAttribute("aria-label", "选中关联笔记以拖动");
      const paint = () => row.classList.toggle("pm-table-row--selected", checkbox.checked);
      checkbox.checked = selection.has(id);
      paint();
      checkbox.addEventListener("click", event => event.stopPropagation());
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selection.add(id);
        else selection.delete(id);
        paint();
      });
      selectCell.append(checkbox);
    }
    const expand = row.insertCell();
    expand.className = "pm-table-cell-expand";
    const linkedId = "projectm-link:" + record.id;
    const hasChildren = record.childTaskIds?.some(id => owner.taskIndex.get(id)?.parentId === null) ||
      (owner.linkedNotes ?? []).some(note => note.parentId === linkedId);
    if (hasChildren) {
      expand.append(this.foldButton(linkedId, "子项"));
    }
    const path = linkedNotePath(record.note);
    const file = this.app.vault.getFileByPath(path);
    const title = file?.basename || path.split("/").pop()?.replace(/\.md$/, "") || record.note;
    const statuses = this.subview.plugin.store.configFor(owner).statuses;
    const status = statuses.find(item => item.id === record.status);
    for (const column of columns) {
      const cell = row.insertCell();
      cell.className = column === "title" ? "pm-table-cell-title" : "pm-table-cell";
      if (column === "title") {
        for (const [level, continues] of guides.entries()) {
          const elbow = level === guides.length - 1;
          if (!elbow && !continues) continue;
          const guide = doc.createElement("span");
          guide.className = "pm-tree-guide";
          if (elbow) guide.classList.add("pm-tree-guide--elbow");
          if (elbow && isLastChild) guide.classList.add("pm-tree-guide--last");
          guide.style.setProperty("--level", level);
          cell.append(guide);
        }
        const titleInner = doc.createElement("div");
        titleInner.className = "pm-table-title-inner";
        const openNote = () => {
          const target = this.app.vault.getFileByPath(path);
          if (target) this.app.workspace.getLeaf("tab").openFile(target);
          else new Notice("找不到原笔记。");
        };
        const label = this.button(title, () => {
          if (typeof this.view.openLinkedTaskDetails === "function") this.view.openLinkedTaskDetails(owner, record.id, path);
          else openNote();
        });
        label.className = "pm-task-title-text projectm-linked-title";
        label.title = title + " · 关联笔记详情";
        label.setAttribute("aria-label", title + "，查看关联笔记详情");
        if (file) {
          const badge = this.button("打开原笔记", openNote, "link-2");
          badge.classList.add("projectm-linked-mark");
          badge.title = "打开原笔记";
          titleInner.append(badge, label);
        } else {
          const badge = doc.createElement("span");
          badge.className = "projectm-linked-label";
          badge.textContent = "原笔记缺失";
          titleInner.append(label, badge);
        }
        cell.append(titleInner);
      } else if (column === "status") {
        const chip = this.button(status?.label || record.status, event => {
          const menu = new Menu();
          for (const choice of statuses) menu.addItem(item => item.setTitle(choice.label).setChecked(choice.id === record.status)
            .onClick(() => this.changeRecords(records => records.map(entry =>
              entry.id === record.id ? { ...entry, status: choice.id } : entry), owner)));
          menu.showAtMouseEvent(event);
        });
        chip.className = "pm-chip pm-chip--solid pm-chip--interactive projectm-linked-control";
        chip.style.setProperty("--pm-chip-color", status?.color || "var(--text-muted)");
        const indicator = doc.createElement("span");
        if (status?.icon) setIcon(indicator, status.icon);
        indicator.className = indicator.childElementCount ? "pm-chip-icon" : "pm-chip-dot";
        indicator.setAttribute("aria-hidden", "true");
        const label = doc.createElement("span");
        label.className = "pm-chip-label";
        label.textContent = chip.textContent;
        chip.replaceChildren(indicator, label);
        cell.append(chip);
      }
    }
    const actions = row.insertCell();
    actions.className = "pm-table-cell pm-table-cell-actions";
    const showActions = event => {
      const menu = new Menu();
      const options = this.subview.linkedNoteGroupOptions?.(record.id);
      if (options?.groups.length && !options.inherited) {
        menu.addItem(item => item.setTitle("更改分组").setIcon("folders").onClick(() =>
          this.chooseGroup("更改关联笔记分组", options, "保存", async groupId => {
            await this.subview.setLinkedNoteGroup(record.id, groupId);
            return true;
          })
        ));
      }
      menu.addItem(item => item.setTitle("解除关联").setIcon("unlink")
        .onClick(() => this.changeRecords(records => records.filter(entry => entry.id !== record.id), owner)));
      menu.showAtMouseEvent(event);
    };
    const actionButton = this.button("关联笔记操作", showActions, "more-horizontal");
    actionButton.classList.add("pm-icon-btn", "pm-icon-btn--hover-only");
    actions.append(actionButton);
    row.addEventListener("contextmenu", event => {
      event.preventDefault();
      event.stopPropagation();
      showActions(event);
    });
    return row;
  }

  destroy() {
    this.observer.disconnect();
    this.toolbarButton?.remove();
    this.win.cancelAnimationFrame(this.frame);
    this.wrapper.removeEventListener("scroll", this.onScroll);
    if (this.state.renderWindow === this.renderWindow) this.state.renderWindow = this.nativeRenderWindow;
    if (this.body.isConnected && this.state.tableBody === this.body) this.nativeRenderWindow?.();
  }
}

module.exports = class DotpmLiveDescription extends Plugin {
  async onload() {
    await this.loadSettings();
    this.applyPalette();
    this.register(() => document.body.classList.remove("dotpm-high-contrast-palette"));
    this.panes = new WeakMap();
    this.mounted = new Set();
    this.timer = null;

    this.addCommand({
      id: "toggle-dotpm-live-description",
      name: "Toggle live description preview",
      callback: async () => {
        this.settings.enabled = !this.settings.enabled;
        await this.saveSettings();
        this.refresh();
        new Notice("dotpm live description: " + (this.settings.enabled ? "开" : "关"));
      },
    });

    this.addSettingTab(new DotpmLiveSettingTab(this.app, this));
    this.inlineTimeViews = new Set();
    this.registerEditorExtension([createInlineTimeExtension(this), reconcileEditedTasks, skipHiddenTaskClock, deletePastHiddenTaskClock, taskSelectionClipboard]);
    this.scheduleCalendarRefresh();
    this.registerMarkdownPostProcessor(root => {
      const doc = root.ownerDocument;
      const walker = doc.createTreeWalker(root, doc.defaultView.NodeFilter.SHOW_TEXT);
      const candidates = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.parentElement?.closest("a, code, pre, .pm-time") && node.textContent.includes("@")) {
          candidates.push(node);
        }
      }
      for (const node of candidates) {
        const text = node.textContent;
        const matches = [...text.matchAll(TIME_MARKER)];
        if (!matches.length) continue;
        const fragment = doc.createDocumentFragment();
        let end = 0;
        for (const match of matches) {
          fragment.append(text.slice(end, match.index));
          const badge = doc.createElement("span");
          badge.className = "pm-time pm-time--markdown pm-time--" + TIME_KIND[match[1]];
          const duration = match[4];
          badge.textContent = match[1] === "计划" && match[2].startsWith("~") ? "截止 @ " + match[2].slice(1) :
            duration ? match[0].replace(duration, duration.replace("（", "(").replace("）", ")")) : match[0];
          fragment.append(badge);
          end = match.index + match[0].length;
        }
        fragment.append(text.slice(end));
        node.replaceWith(fragment);
      }
    });

    // 启动自愈：清理上次异常退出可能留下的残留
    this.purgeStrays();
    this.skipDotpmDescriptionPreview();
    this.registerTaskProgressSync();

    this.addCommand({
      id: "cleanup-dotpm-live",
      name: "清理残留的 Live 编辑器 / 窗格",
      callback: () => {
        const n = this.purgeStrays();
        new Notice("dotpm live: 已清理 " + n + " 处残留");
      },
    });

    this.observer = new MutationObserver(records => {
      if (!descriptionStructureChanged(records, SECTION_SEL + ", " + TEXTAREA_SEL + ", .dotpm-live-native")) return;
      // The native editor mounts synchronously. Replace the preview before the browser paints it.
      if (this.settings.enabled && this.settings.mode === "live2") this.refresh();
      else this.schedule();
    });
    this.observer.observe(document.body, { childList: true, subtree: true });

    // 输入 / 焦点事件：委托到 document，避免给每个 textarea 单独绑监听
    this.onInput = this.onFocus = (ev) => {
      const el = ev.target;
      if (!el?.matches?.(TEXTAREA_SEL)) return;
      if (this.live2Bindings?.get(el.closest(SECTION_SEL))?.ta === el) return;
      this.schedule();
    };
    document.addEventListener("input", this.onInput, true);
    document.addEventListener("focusin", this.onFocus, true);

    this.register(await installDatePicker({ plugin: this, app: this.app, obsidian: require("obsidian") }));
    this.installLinkedNotes();
    this.refresh();
  }

  onunload() {
    if (this.observer) this.observer.disconnect();
    document.removeEventListener("input", this.onInput, true);
    document.removeEventListener("focusin", this.onFocus, true);
    clearTimeout(this.timer);
    clearTimeout(this.calendarRefreshTimer);
    this.unmountAll();
  }

  installLinkedNotes() {
    const { workspace, vault, metadataCache, fileManager } = this.app;
    const tables = new Map();
    const collapsedByProject = new Map();
    let queued = false;
    let disposed = false;
    const sync = () => {
      queued = false;
      if (disposed) return;
      const active = new Set();
      if (this.settings.enabled) {
        for (const leaf of workspace.getLeavesOfType("pm-project")) {
          const view = leaf.view;
          const state = view.subview?.state;
          if (view.currentView !== "table" || !["project", "subtree"].includes(view.projectScope?.spec.kind) ||
              !state?.tableBody?.isConnected || !state.renderWindow || !view.project?.taskIndex) continue;
          const path = view.project.filePath;
          if (!vault.getFileByPath(path)) continue;
          active.add(view);
          const previous = tables.get(view);
          if (previous?.body === state.tableBody && previous.project === view.project) {
            previous.mountToolbar();
            continue;
          }
          previous?.destroy();
          if (!collapsedByProject.has(path)) collapsedByProject.set(path, new Set());
          tables.set(view, new LinkedNotesTable(this.app, view, collapsedByProject.get(path)));
        }
      }
      for (const [view, table] of tables) {
        if (!active.has(view)) {
          table.destroy();
          tables.delete(view);
        }
      }
    };
    const schedule = () => {
      if (queued || disposed) return;
      queued = true;
      queueMicrotask(sync);
    };
    this.scheduleLinkedNotes = schedule;
    const observer = new MutationObserver(mutations => {
      const selector = ".pm-table-wrapper, .pm-table > tbody, .pm-vh-actions, .pm-vh-actions > .pm-split-btn";
      if (mutations.some(({ addedNodes, removedNodes }) => [...addedNodes, ...removedNodes].some(node =>
        node.nodeType === 1 && (node.matches(selector) || node.querySelector(selector))))) schedule();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    this.registerEvent(workspace.on("layout-change", schedule));
    this.registerEvent(metadataCache.on("changed", file => {
      for (const table of tables.values()) {
        if (table.view.projectScope?.projects.some(project => project.filePath === file.path)) table.render();
      }
    }));
    this.registerEvent(vault.on("rename", (file, oldPath) => {
      if (file.extension !== "md") return;
      const oldLink = "[[" + oldPath + "]]";
      const newLink = "[[" + file.path + "]]";
      for (const project of vault.getMarkdownFiles()) {
        const properties = metadataCache.getFileCache(project)?.frontmatter;
        if (!properties?.["pm-project"] || !linkedNoteRecords(properties).some(record => record.note === oldLink)) continue;
        const rename = records => records.map(record => record.note === oldLink ? { ...record, note: newLink } : record);
        const store = this.app.plugins.plugins["project-manager"]?.store;
        if (typeof store?.updateLinkedNotes === "function") {
          store.loadProjectByPath(project.path).then(current => {
            if (current) return store.updateLinkedNotes(current, rename);
          }).catch(error => console.error("[dotpm-live-desc] Could not update renamed linked note", error));
          continue;
        }
        fileManager.processFrontMatter(project, current => {
          const records = linkedNoteRecords(current);
          if (records.some(record => record.note === oldLink)) {
            current[LINKED_NOTES_PROPERTY] = rename(records);
          }
        }).catch(error => console.error("[dotpm-live-desc] Could not update renamed linked note", error));
      }
    }));
    this.register(() => {
      disposed = true;
      observer.disconnect();
      for (const table of tables.values()) table.destroy();
      tables.clear();
      this.scheduleLinkedNotes = null;
    });
    schedule();
  }

  installDotpmProgressWrite() {
    const store = this.app.plugins.plugins["project-manager"]?.store;
    if (!store || this.progressWriteStore === store || typeof store.saveTaskFile !== "function") return;
    this.progressWriteStore = store;
    const saveTaskFile = store.saveTaskFile;
    const { vault, metadataCache } = this.app;
    const plugin = this;
    let active = true;
    function saveWithChecklistProgress(task, project, parent, path, kind) {
      if (active && plugin.settings.enabled && kind !== "fm" && !plugin.linkedRollupWrites?.has(task) &&
          !Object.hasOwn(project.linkedRollups || {}, task.id) &&
          this.hydratedBodies?.has(task) && typeof task.description === "string") {
        const tabSize = Number(vault.getConfig("tabSize")) || 4;
        const { closed, total } = calculateTaskProgress(Text.of(task.description.split(/\r?\n/)), tabSize);
        const file = task.filePath && vault.getFileByPath(task.filePath);
        const hadTasks = file && metadataCache.getFileCache(file)?.listItems?.some(item => typeof item.task === "string");
        if (total || hadTasks) task.progress = progressPercent(closed, total);
      }
      return Reflect.apply(saveTaskFile, this, arguments);
    }
    store.saveTaskFile = saveWithChecklistProgress;
    this.register(() => {
      active = false;
      if (store.saveTaskFile === saveWithChecklistProgress) store.saveTaskFile = saveTaskFile;
    });
  }

  installLinkedRollup() {
    const store = this.app.plugins.plugins["project-manager"]?.store;
    if (!store || typeof store.updateLinkedNotes === "function" ||
        this.linkedRollupStore === store || typeof store.doSaveProject !== "function") return;
    this.linkedRollupStore = store;
    const original = store.doSaveProject;
    const writes = this.linkedRollupWrites ||= new WeakSet();
    const { vault, fileManager } = this.app;
    const plugin = this;
    let active = true;

    async function saveWithLinkedRollup(project) {
      const file = active && plugin.settings.enabled && vault.getFileByPath(project.filePath);
      if (!file || !project.taskIndex) return original.call(this, project);
      const info = getFrontMatterInfo(await vault.read(file));
      let properties;
      try {
        properties = info.exists ? parseYaml(info.frontmatter) : null;
      } catch {
        return original.call(this, project);
      }
      const saved = properties?.[LINKED_ROLLUP_PROPERTY];
      const prior = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
      const parents = [...linkedRollupParents(project, linkedNoteRecords(properties), prior).values()];
      if (!parents.length && !Object.keys(prior).length) return original.call(this, project);
      const { kind, idFor } = linkedStatusRules(this.statusesFor(project));
      const next = Object.create(null);
      try {
        for (const parent of parents.sort((a, b) => b.depth - a.depth)) {
          const { task, active: hasLinks } = parent;
          const { closed, total, states } = linkedChildStats(parent, kind);
          if (!total) continue;
          writes.add(task);
          const current = kind(task.status);
          const override = (current === "hold" || current === "cancel") && prior[task.id] !== task.status;
          const target = aggregateTaskStates(states).next;
          const status = override || target === current ? task.status : idFor(target) || task.status;
          if (hasLinks) next[task.id] = !override && ["hold", "cancel"].includes(kind(status)) ? status : "";
          const progress = progressPercent(closed, total);
          if (task.progress === progress && task.status === status) continue;
          const patch = { progress };
          if (task.status !== status) patch.status = status;
          this.stampCompletion(project, task, patch);
          Object.assign(task, patch, { updatedAt: new Date().toISOString() });
          this.markDirty(project, [task.id], "fm");
        }
        if (Object.keys(prior).length !== Object.keys(next).length ||
            Object.entries(next).some(([id, status]) => prior[id] !== status)) {
          this.markSelfWrite(project.filePath);
          await fileManager.processFrontMatter(file, frontmatter => {
            if (Object.keys(next).length) frontmatter[LINKED_ROLLUP_PROPERTY] = { ...next };
            else delete frontmatter[LINKED_ROLLUP_PROPERTY];
          });
        }
        return await original.call(this, project);
      } finally {
        for (const { task } of parents) writes.delete(task);
      }
    }

    store.doSaveProject = saveWithLinkedRollup;
    this.register(() => {
      active = false;
      if (store.doSaveProject === saveWithLinkedRollup) store.doSaveProject = original;
    });
  }

  isLinkedRollupTask(file) {
    if (!file || !this.settings.enabled) return false;
    const { vault, metadataCache, plugins } = this.app;
    const properties = metadataCache.getFileCache(file)?.frontmatter;
    if (!properties?.["pm-task"] || typeof properties.projectId !== "string") return false;
    const ref = linkedNotePath(properties.projectId).split("|")[0];
    const projectPath = plugins.plugins["project-manager"]?.index?.projectRefs()
      .find(project => project.id === properties.projectId)?.path;
    const project = ref ? metadataCache.getFirstLinkpathDest(ref, file.path) : projectPath && vault.getFileByPath(projectPath);
    if (!project) return false;
    const rollups = metadataCache.getFileCache(project)?.frontmatter?.[LINKED_ROLLUP_PROPERTY];
    return Object.hasOwn(rollups || {}, properties.id);
  }

  registerTaskProgressSync() {
    const { vault, metadataCache } = this.app;
    const timers = new Map();
    const tracked = new WeakSet();
    let disposed = false;

    const queue = (file, delay = 250) => {
      if (disposed || file.extension !== "md") return;
      clearTimeout(timers.get(file));
      timers.set(file, setTimeout(async () => {
        timers.delete(file);
        const store = this.app.plugins.plugins["project-manager"]?.store;
        if (this.isLinkedRollupTask(file)) return;
        if (store?.peekSelfWrite?.(file.path)) {
          queue(file, (store.constructor.SELF_WRITE_WINDOW_MS || 5000) + 25);
          return;
        }
        try {
          const source = await vault.read(file);
          if (disposed || timers.has(file)) return;
          const tabSize = Number(vault.getConfig("tabSize")) || 4;
          const hadTasks = tracked.has(file);
          const updated = updateSavedTaskProgress(source, tabSize, hadTasks);
          const cache = metadataCache.getFileCache(file);
          if (cache?.listItems?.some(item => typeof item.task === "string")) tracked.add(file);
          if (updated !== source) {
            await vault.process(file, current => disposed || this.isLinkedRollupTask(file) ? current :
              updateSavedTaskProgress(current, tabSize, hadTasks));
            tracked.add(file);
          }
        } catch (error) {
          if (!disposed && vault.getAbstractFileByPath(file.path) === file) {
            console.error("[dotpm-live-desc] Could not synchronize task progress", error);
          }
        }
      }, delay));
    };

    const schedule = file => {
      if (file.extension !== "md") return;
      if (metadataCache.getFileCache(file)?.listItems?.some(item => typeof item.task === "string")) tracked.add(file);
      queue(file);
    };
    this.registerEvent(vault.on("modify", schedule));
    this.registerEvent(vault.on("create", schedule));
    this.register(() => {
      disposed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    });
  }

  skipDotpmDescriptionPreview() {
    const render = MarkdownRenderer.render;
    const plugin = this;
    this.skippedPreviews = new WeakSet();
    let active = true;
    function renderUnlessReplaced(app, text, target, ...args) {
      if (active && app === plugin.app && plugin.settings.enabled && plugin.settings.mode === "live2" &&
          target?.matches?.(PREVIEW_SEL) && target !== plugin.restoringPreview) {
        const section = target.parentElement;
        if (section?.matches(SECTION_SEL) && section.closest(".pm-te-surface")) {
          const source = section.querySelector(TEXTAREA_SEL);
          if (source?.value === text && !plugin.failedLive2Sources?.has(source)) {
            plugin.skippedPreviews.add(target);
            return Promise.resolve();
          }
        }
      }
      return Reflect.apply(render, this, [app, text, target, ...args]);
    }

    MarkdownRenderer.render = renderUnlessReplaced;
    this.register(() => {
      active = false;
      if (MarkdownRenderer.render === renderUnlessReplaced) MarkdownRenderer.render = render;
    });
  }

  restoreDotpmDescriptionPreview(sec, source) {
    if (!source.isConnected || sec.querySelector(TEXTAREA_SEL) !== source) return;
    const preview = sec.querySelector(PREVIEW_SEL);
    if (!this.skippedPreviews?.delete(preview)) return;

    // Let dotpm render the current textarea value and restore its preview listeners.
    this.restoringPreview = preview;
    try {
      source.dispatchEvent(new source.ownerDocument.defaultView.Event("blur"));
    } finally {
      this.restoringPreview = null;
    }
  }

  // 清理一切可能的残留（幂等）
  purgeStrays() {
    let n = 0;
    try {
      document.querySelectorAll(".dotpm-live-editor-host").forEach((el) => {
        const sec = el.closest(SECTION_SEL);
        if (this.live2Bindings?.get(sec)?.host === el || this.liveBindings?.get(sec)?.host === el) return;
        const ta = sec && sec.querySelector(TEXTAREA_SEL);
        if (ta) { ta.style.display = ""; ta.classList.remove("dotpm-live-hidden-source"); }
        el.remove();
        n++;
      });
      document.querySelectorAll(".dotpm-ld-wrap").forEach((w) => {
        const sec = w.closest(SECTION_SEL);
        if (sec) this.unmount(sec); else w.remove();
        n++;
      });
      document.querySelectorAll(".workspace-leaf[data-dotpm-live-hidden='1']").forEach((el) => {
        el.style.display = "";
        delete el.dataset.dotpmLiveHidden;
        n++;
      });
      // 兜底：任何被本插件隐藏但仍带标记的窗格
      document.querySelectorAll("[data-dotpm-live-hidden]").forEach((el) => {
        el.style.display = "";
        delete el.dataset.dotpmLiveHidden;
        n++;
      });
      if (window.__dotpmLiveEditor && !document.querySelector(LIVE_SEL)) {
        window.__dotpmLiveEditor = null;
        n++;
      }
    } catch (e) {}
    return n;
  }

  applyPalette() {
    document.body.classList.toggle("dotpm-high-contrast-palette", this.settings.highContrastPalette);
  }

  async setRunningTimeOptions(options) {
    Object.assign(this.settings, options);
    this.refreshInlineTimeViews();
    await this.saveSettings();
  }

  refreshInlineTimeViews() {
    for (const view of this.inlineTimeViews) {
      view.dispatch({ effects: refreshInlineTime.of(null) });
    }
  }

  scheduleCalendarRefresh() {
    const midnight = new Date();
    midnight.setHours(24, 0, 0, 0);
    this.calendarRefreshTimer = setTimeout(() => {
      this.scheduleCalendarRefresh();
      this.refreshInlineTimeViews();
    }, midnight.getTime() - Date.now());
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    const refreshSeconds = Number(this.settings.runningTimeRefreshSeconds);
    this.settings.runningTimeRefreshSeconds = Object.hasOwn(RUNNING_TIME_FREQUENCIES, refreshSeconds)
      ? refreshSeconds : DEFAULT_SETTINGS.runningTimeRefreshSeconds;
  }
  async saveSettings() {
    const settings = { ...this.settings };
    this.settingsWrite = (this.settingsWrite || Promise.resolve()).catch(() => {})
      .then(() => this.saveData(settings));
    await this.settingsWrite;
  }

  rememberDescriptionSize(setting, size) {
    if (this.settings[setting] === size) return;
    this.settings[setting] = size;
    this.saveSettings().catch(error => console.error("[dotpm-live-desc] Could not save description size", error));
  }

  schedule() {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.refresh();
    }, 120);
  }

  refresh() {
    this.scheduleLinkedNotes?.();
    this.installLinkedRollup();
    this.installDotpmProgressWrite();
    if (this.liveBindings) {
      [...this.liveBindings.keys()].forEach((sec) => {
        if (!sec.isConnected) this.teardownLive(sec);
      });
    }
    if (this.live2Bindings) {
      for (const [sec, binding] of this.live2Bindings) {
        if (!binding.host?.isConnected || binding.ta !== sec.querySelector(TEXTAREA_SEL)) {
          this.teardownLive2(sec);
        }
      }
    }
    if (!this.settings.enabled) {
      this.unmountAll();
      return;
    }
    const mode = this.settings.mode || "preview";
    const live = mode === "live" || mode === "live2";
    const sections = document.querySelectorAll(SECTION_SEL);
    sections.forEach((sec) => {
      const ta = sec.querySelector(TEXTAREA_SEL);
      if (!ta) return;
      if (mode === "live2") {
        this.mountLive2(sec, ta);
      } else if (mode === "live") {
        this.mountLive(sec, ta);
      } else {
        this.teardownLive(sec);
        this.mount(sec, ta);
      }
    });
    if (live) this.unmountAllPreview();
  }

  mountLive(sec, ta) {
    if (ta.classList.contains("pm-hidden")) {
      // dotpm 处于预览态：先把编辑区亮出来，否则编辑器无处安放
      const own = sec.querySelector(PREVIEW_SEL);
      if (own) own.classList.add("pm-hidden");
      ta.classList.remove("pm-hidden");
    }
    this.liveBindings = this.liveBindings || new Map();
    const existing = this.liveBindings.get(sec);
    if (existing && !existing.destroyed) return;
    const binding = new LiveEditorBinding(this, sec, ta);
    this.liveBindings.set(sec, binding);
    binding.mount().catch((e) => {
      new Notice("Live 编辑器挂载失败：" + e.message + "（已回退到预览模式）");
      this.settings.mode = "preview";
      this.saveSettings();
      this.liveBindings.delete(sec);
      this.mount(sec, ta);
    });
  }

  mountLive2(sec, ta) {
    this.live2Bindings ||= new Map();
    const existing = this.live2Bindings.get(sec);
    if (existing?.ta === ta) return;
    if (existing) this.teardownLive2(sec);
    if (this.failedLive2Sources?.has(ta)) return;

    const binding = new EmbeddedEditorBinding(this, sec, ta);
    this.live2Bindings.set(sec, binding);
    try {
      binding.mount();
    } catch (error) {
      this.teardownLive2(sec);
      this.failedLive2Sources ||= new WeakSet();
      this.failedLive2Sources.add(ta);
      console.error("[dotpm-live-desc] Live Preview could not be mounted", error);
      new Notice("Live Preview 初始化失败，此任务已恢复 dotpm 原编辑器。");
    }
  }

  teardownLive2(sec) {
    if (!this.live2Bindings) return;
    const b = this.live2Bindings.get(sec);
    if (!b) return;
    this.live2Bindings.delete(sec);
    try {
      b.destroy();
    } catch (error) {
      console.error("[dotpm-live-desc] Could not destroy embedded editor", error);
    } finally {
      this.restoreDotpmDescriptionPreview(sec, b.ta);
    }
  }

  teardownLive(sec) {
    if (!this.liveBindings) return;
    const b = this.liveBindings.get(sec);
    if (b) {
      b.destroy();
      this.liveBindings.delete(sec);
    }
  }

  unmountAllPreview() {
    document.querySelectorAll(".dotpm-ld-wrap").forEach((w) => {
      const sec = w.closest(SECTION_SEL);
      if (sec) this.unmount(sec);
      else w.remove();
    });
  }

  mount(sec, ta) {
    // 清理历史遗留（例如早期 QuickAdd 脚本文本版预览）
    sec.querySelectorAll(".dotpm-live").forEach((n) => n.remove());
    let wrap = sec.querySelector(".dotpm-ld-wrap");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.className = "dotpm-ld-wrap is-" + this.settings.layout;

      const source = document.createElement("div");
      source.className = "dotpm-ld-source";

      const pane = document.createElement("div");
      pane.className = "dotpm-ld-pane";

      const badge = document.createElement("div");
      badge.className = "dotpm-ld-badge";
      badge.textContent = "Live Preview";

      wrap.appendChild(source);
      wrap.appendChild(pane);
      if (this.settings.showBadge) pane.appendChild(badge);
      sec.appendChild(wrap);
      this.mounted.add(sec);
    }

    wrap.className = "dotpm-ld-wrap is-" + this.settings.layout;
    const pane = wrap.querySelector(".dotpm-ld-pane");
    if (pane) pane.style.maxHeight = this.settings.maxHeight + "px";

    // 把原 textarea 挪进左边容器（保留原节点与全部事件，dotpm 逻辑不受影响）
    const source = wrap.querySelector(".dotpm-ld-source");
    if (source && ta.parentElement !== source) {
      source.appendChild(ta);
      // 原来 textarea 的兄弟预览节点也让它们跟随
      sec.querySelectorAll(PREVIEW_SEL).forEach((p) => {
        if (p.parentElement !== source) source.appendChild(p);
      });
    }
    this.render(ta);
  }

  render(ta) {
    if (!this.settings.enabled || !ta || !ta.isConnected) return;
    const sec = ta.closest(SECTION_SEL) || ta.parentElement;
    const wrap = sec && sec.querySelector(".dotpm-ld-wrap");
    const pane = wrap && wrap.querySelector(".dotpm-ld-pane");
    if (!pane) return;

    const own = sec.querySelector(PREVIEW_SEL);
    const ownVisible = own && !own.classList.contains("pm-hidden");
    const text = ta.value || "";
    if (ownVisible || !text.trim()) {
      pane.classList.add("is-empty");
      pane.dataset.src = "";
      return;
    }

    if (pane.dataset.src === text) {
      pane.classList.remove("is-empty");
      return;
    }
    pane.dataset.src = text;
    pane.classList.remove("is-empty");

    const badge = pane.querySelector(".dotpm-ld-badge");
    pane.empty();
    if (badge) pane.appendChild(badge);

    const file = this.app.workspace.getActiveFile();
    const src = file ? file.path : "";
    try {
      MarkdownRenderer.render(this.app, text, pane, src, this);
    } catch (e) {
      const pre = document.createElement("pre");
      pre.textContent = text;
      pane.appendChild(pre);
    }
  }

  unmount(sec) {
    const wrap = sec && sec.querySelector(".dotpm-ld-wrap");
    if (!wrap) return;
    const source = wrap.querySelector(".dotpm-ld-source");
    const parent = wrap.parentElement;
    if (source && parent) {
      while (source.firstChild) parent.insertBefore(source.firstChild, wrap);
    }
    wrap.remove();
    this.mounted.delete(sec);
  }

  unmountAll() {
    if (this.liveBindings) {
      [...this.liveBindings.keys()].forEach((sec) => this.teardownLive(sec));
    }
    if (this.live2Bindings) {
      [...this.live2Bindings.keys()].forEach((sec) => this.teardownLive2(sec));
    }
    [...document.querySelectorAll(".dotpm-ld-wrap")].forEach((wrap) => {
      const sec = wrap.closest(SECTION_SEL);
      if (sec) this.unmount(sec);
      else wrap.remove();
    });
    this.mounted.clear();
  }
};


/* ────────────────────────────────────────────────────────────────
 * Live 模式：把真实 MarkdownView 的 CM6 编辑器搬进任务弹窗
 * 机制：新建 scratch 文件 → 打开为一个后台 MarkdownView → 取其 cm.dom
 *       搬入描述区 → 隐藏后台窗格；关闭时还回 DOM 并 detach。
 * 同步：编辑器 → textarea（触发 dotpm 原有 input/change 保存）
 *       textarea → 编辑器（外部插入，如 QuickAdd）
 * ──────────────────────────────────────────────────────────────── */
const SCRATCH_PATH = "vault-attachments/__dotpm-live-scratch.md";
const LIVE_SEL = ".dotpm-live-editor-host";

class LiveEditorBinding {
  constructor(plugin, sec, ta) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.sec = sec;
    this.ta = ta;
    this.leaf = null;
    this.editor = null;
    this.host = null;
    this.hiddenLeafEl = null;
    this.originalParent = null;
    this.syncing = false;
    this.timer = null;
    this.destroyed = false;
  }

  async mount() {
    const { app, sec, ta } = this;
    if (this.destroyed) return;
    if (sec.querySelector(LIVE_SEL)) return;

    // 1) scratch 文件（幂等）
    let file = app.vault.getAbstractFileByPath(SCRATCH_PATH);
    const initial = ta.value || "";
    if (!file) {
      await app.vault.create(SCRATCH_PATH, initial);
      file = app.vault.getAbstractFileByPath(SCRATCH_PATH);
    } else {
      await app.vault.modify(file, initial);
    }
    if (!file) throw new Error("scratch 文件创建失败");

    // 2) 后台 MarkdownView
    this.leaf = app.workspace.getLeaf("split");
    await this.leaf.openFile(file);
    await new Promise((r) => setTimeout(r, 350));
    const view = this.leaf.view;
    this.editor = view.editor;
    const cm = this.editor.cm;
    this.originalParent = cm.dom.parentElement;

    // 3) 宿主容器：放在 textarea 之前，textarea 隐藏但保留（dotpm 保存仍用它）
    const host = document.createElement("div");
    host.className = "dotpm-live-editor-host";
    host.style.minHeight = "180px";
    host.style.maxHeight = (this.plugin.settings.maxHeight || 420) + "px";
    ta.insertAdjacentElement("beforebegin", host);
    host.appendChild(cm.dom);
    this.host = host;

    ta.classList.add("dotpm-live-hidden-source");
    ta.style.display = "none";

    // 4) 隐藏后台窗格
    const leafEl = view.containerEl && view.containerEl.closest ? view.containerEl.closest(".workspace-leaf") : null;
    if (leafEl) {
      this.hiddenLeafEl = leafEl;
      leafEl.dataset.dotpmLiveHidden = "1";
      leafEl.style.display = "none";
    }

    if (cm.requestMeasure) cm.requestMeasure();

    // 5) 监听编辑变化
    this.onEditorChange = this.onEditorChange.bind(this);
    this.refs = this.app.workspace.on("editor-change", this.onEditorChange);

    // 6) 监听 textarea 外部变化（例如 QuickAdd 插入）
    this.onTaInput = () => {
      if (this.syncing || !this.editor) return;
      const text = this.ta.value || "";
      if (text === this.editor.getValue()) return;
      this.pushToEditor(text);
    };
    this.ta.addEventListener("input", this.onTaInput, true);
    this.onHostFlush = () => this.flushToTextarea();
    this.ta.addEventListener("pm-flush-description", this.onHostFlush);

    // 暴露给日期选择器脚本做光标插入
    try {
      window.__dotpmLiveEditor = {
        getValue: () => (this.editor ? this.editor.getValue() : ""),
        insertAtCursor: (text) => this.insertAtCursor(text),
        setValue: (v) => this.pushToEditor(v),
        isActive: () => !!(this.editor && this.host && this.host.isConnected),
      };
    } catch (e) {}
  }

  pushToEditor(text) {
    if (!this.editor) return;
    this.syncing = true;
    try {
      const cm = this.editor.cm;
      const doc = cm.state.doc;
      cm.dispatch({ changes: { from: 0, to: doc.length, insert: text } });
    } catch (e) {}
    this.syncing = false;
  }

  insertAtCursor(text) {
    if (!this.editor) return false;
    try {
      const ed = this.editor;
      ed.replaceSelection(text);
      this.flushToTextarea();
      return true;
    } catch (e) {
      return false;
    }
  }

  flushToTextarea() {
    if (!this.editor || !this.ta || this.syncing) return;
    const value = this.editor.getValue();
    if (this.ta.value === value) return;
    this.syncing = true;
    this.ta.value = value;
    this.ta.dispatchEvent(new Event("input", { bubbles: true }));
    this.ta.dispatchEvent(new Event("change", { bubbles: true }));
    this.syncing = false;
  }

  onEditorChange(editor) {
    if (!this.editor || editor !== this.editor) return;
    if (this.syncing) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!this.destroyed) this.flushToTextarea();
    }, 150);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this.timer);
    try { this.flushToTextarea(); } catch (e) {}
    try { if (this.refs) this.app.workspace.offref(this.refs); } catch (e) {}
    try { this.ta.removeEventListener("input", this.onTaInput, true); } catch (e) {}
    this.ta.removeEventListener("pm-flush-description", this.onHostFlush);
    try {
      const cm = this.editor && this.editor.cm;
      if (cm && this.originalParent) {
        this.originalParent.appendChild(cm.dom);
        if (cm.requestMeasure) cm.requestMeasure();
      }
    } catch (e) {}
    try { if (this.hiddenLeafEl) this.hiddenLeafEl.style.display = ""; } catch (e) {}
    try {
      document.querySelectorAll('.workspace-leaf[data-dotpm-live-hidden="1"]').forEach((el) => {
        el.style.display = "";
        delete el.dataset.dotpmLiveHidden;
      });
    } catch (e) {}
    try { if (this.leaf) this.leaf.detach(); } catch (e) {}
    // 清空 scratch，避免任务描述残留在临时笔记里
    try {
      const alive = this.plugin.liveBindings && [...this.plugin.liveBindings.values()].some((b) => !b.destroyed);
      const f = this.app.vault.getAbstractFileByPath(SCRATCH_PATH);
      if (!alive && f) this.app.vault.modify(f, "");
    } catch (e) {}
    try {
      this.ta.style.display = "";
      this.ta.classList.remove("dotpm-live-hidden-source");
    } catch (e) {}
    try { if (this.host) this.host.remove(); } catch (e) {}
    try { if (window.__dotpmLiveEditor && !document.querySelector(LIVE_SEL)) window.__dotpmLiveEditor = null; } catch (e) {}
  }
}


// Adapted from the MIT-licensed Markdown embed probe by Matthew Meyers and Fevol.
function resolveNativeEditor(app, doc) {
  const widget = app.embedRegistry.embedByExtension.md({
    app,
    containerEl: doc.createElement("div"),
  }, null, "");
  try {
    widget.editable = true;
    widget.showEditor();
    const prototype = Object.getPrototypeOf(Object.getPrototypeOf(widget.editMode));
    return prototype.constructor;
  } finally {
    widget.unload();
  }
}

class EmbeddedEditorBinding {
  constructor(plugin, sec, ta) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.sec = sec;
    this.ta = ta;
    this.win = ta.ownerDocument.defaultView;
    this.syncing = false;
  }

  contextFile() {
    const surface = this.sec.closest(".pm-te-surface");
    const taskPath = surface?.querySelector(".pm-te-footer-path")?.textContent.trim();
    if (taskPath) return this.app.vault.getFileByPath(taskPath);
    const projectTitle = surface?.querySelector(".pm-te-crumb-name")?.textContent.trim();
    if (!projectTitle) return null;
    const projects = this.app.plugins.plugins["project-manager"]?.index?.projectRefs() || [];
    const matches = projects.filter(project => project.title === projectTitle);
    return matches.length === 1 ? this.app.vault.getFileByPath(matches[0].path) : null;
  }

  mount() {
    const doc = this.ta.ownerDocument;
    const NativeEditor = this.plugin.nativeEditorCtor ||= resolveNativeEditor(this.app, doc);
    const host = this.host = doc.createElement("div");
    host.className = "dotpm-live-editor-host dotpm-live-native";
    host.style.maxHeight = this.plugin.settings.maxHeight + "px";
    const rememberedHeight = this.plugin.settings.descriptionHeight;
    if (Number.isFinite(rememberedHeight) && rememberedHeight >= 180) {
      host.classList.add("dotpm-live-native-resized");
      host.style.height = rememberedHeight + "px";
    }
    this.ta.before(host);

    const owner = this.owner = {
      app: this.app,
      file: this.contextFile(),
      containerEl: host,
      getMode: () => "source",
      syncScroll() {},
    };
    const native = this.native = new NativeEditor(this.app, host, owner);
    this.view = native.editor.cm;
    owner.editMode = native;
    owner.editor = native.editor;
    native.sourceMode = false;
    native.parseFrontmatter = false;
    const clipboard = native.clipboardManager;
    clipboard.saveAttachment = async (name, extension, data, trailingBreak) => {
      if (name === "Pasted image") name += " " + this.win.moment().format("YYYYMMDDHHmmss");
      const file = await this.saveAttachment(extension ? name + "." + extension : name, data);
      if (file && this.view?.dom.isConnected) clipboard.insertAttachmentEmbed(file, trailingBreak);
    };

    const onUpdate = native.onUpdate;
    native.onUpdate = (update, changed) => {
      if (update.docChanged) this.flush();
      onUpdate.call(native, update, changed);
      if (update.docChanged || update.transactions.some(transaction => transaction.effects.length)) {
        this.rememberFolds();
      }
    };
    native.load();
    native.set(this.ta.value);
    this.restoreFolds();
    const notion = this.app.plugins.plugins["feel-the-notion"];
    if (notion?.settings?.enabled) {
      host.classList.add("dotpm-live-feel-notion");
      const handle = this.view.scrollDOM.querySelector(":scope > .block-handle-wrap");
      handle?.classList.toggle("is-right", notion.settings.handleSide === "right");
    }
    this.addResizeHandle(host);
    const modal = this.sec.closest(".pm-modal--task");
    if (modal) this.addResizeHandle(modal, true);

    // 时间追踪：快照 + 事务钩子（复选框切换等任何文档变更都会触发）
    this.view.contentDOM.setAttribute("aria-label", this.ta.placeholder);

    this.onTaInput = () => {
      if (!this.syncing) this.pushToView(this.ta.value);
    };
    this.ta.addEventListener("input", this.onTaInput);
    this.onFocus = () => {
      const workspace = this.app.workspace;
      if (workspace.activeEditor !== owner) {
        this.previousEditor = workspace.activeEditor;
        workspace.activeEditor = owner;
      }
      if (!this.shortcutScope) {
        const current = this.app.keymap.getWindowStack(this.win).scope;
        this.shortcutScope = new Scope(this.app.scope);
        // Preserve the task modal's Escape and save shortcuts above global editor commands.
        for (const key of current.keys || []) {
          if (key.key === "Escape" || key.key === "Enter") {
            this.shortcutScope.keys.push({ ...key, scope: this.shortcutScope });
          }
        }
        this.app.keymap.pushScope(this.shortcutScope);
      }
      this.expose();
    };
    this.onBlur = () => this.releaseActiveEditor();
    this.onKeyDown = (event) => {
      if (event.key === "Enter" && !event.defaultPrevented && !event.isComposing &&
          !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey &&
          this.view.contentDOM.contains(event.target)) {
        const state = this.view.state;
        const line = state.doc.lineAt(state.selection.main.head);
        if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(line.text)) {
          event.preventDefault();
          event.stopPropagation();
          this.view.dispatch(state.replaceSelection("\n"), { userEvent: "input" });
          return;
        }
      }
      if (event.key !== "@" || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
      this.win.clearTimeout(this.dateTimer);
      this.dateTimer = this.win.setTimeout(() => {
        if (!this.view || this.plugin.activeLive2 !== this) return;
        const { doc, selection } = this.view.state;
        const head = selection.main.head;
        if (head && doc.sliceString(head - 1, head) === "@") {
          this.win.__dotpmOpenDatePicker?.({ start: head - 1, end: head });
        }
      }, 0);
    };
    this.onDrop = (event) => {
      const files = Array.from(event.dataTransfer?.files || []);
      if (!files.length) return;
      // Prevent dotpm's section listener from appending separately to the hidden textarea.
      event.stopPropagation();
      if (event.defaultPrevented) return;
      event.preventDefault();
      const clipboard = this.native.clipboardManager;
      const entries = files.map(file => {
        const dot = file.name.lastIndexOf(".");
        return {
          name: dot > 0 ? file.name.slice(0, dot) : file.name,
          extension: dot > 0 ? file.name.slice(dot + 1) : "",
          data: file.arrayBuffer(),
        };
      });
      clipboard.insertFiles(entries).catch(error => {
        console.error("[dotpm-live-desc] Could not import attachment", error);
        new Notice("无法导入任务附件。");
      });
    };
    this.view.contentDOM.addEventListener("focus", this.onFocus);
    this.view.contentDOM.addEventListener("blur", this.onBlur);
    host.addEventListener("keydown", this.onKeyDown, true);
    this.onSectionDrop = (event) => {
      if (!host.contains(event.target)) this.onDrop(event);
    };
    this.sec.addEventListener("drop", this.onSectionDrop, true);
    host.addEventListener("drop", this.onDrop);
    this.sec.classList.add("dotpm-live-native-mounted");
    this.expose();
  }

  foldSnapshot() {
    const { doc } = this.view.state;
    const { folds } = this.native.getFoldInfo();
    return {
      lines: doc.lines,
      folds: folds.map(({ from }) => ({ from, text: doc.line(from + 1).text })),
    };
  }

  restoreFolds() {
    if (typeof this.native.getFoldInfo !== "function" || typeof this.native.applyFoldInfo !== "function") return;
    if (typeof this.app.loadLocalStorage !== "function" || typeof this.app.saveLocalStorage !== "function") return;
    const surface = this.sec.closest(".pm-te-surface");
    const id = surface?.querySelector(".pm-te-crumb-id")?.textContent.trim();
    const path = surface?.querySelector(".pm-te-footer-path")?.textContent.trim();
    if (!id && !path) return;
    const key = "dotpm-live-desc:description-folds:" + (id ? "task:" + id : "path:" + path);
    const saved = this.app.loadLocalStorage(key);
    if (Array.isArray(saved?.folds) && saved.folds.length) {
      const { doc } = this.view.state;
      const anchors = new Map(saved.folds.map(fold => [fold.text, []]));
      for (let number = 1; number <= doc.lines; number++) {
        const line = doc.line(number);
        anchors.get(line.text)?.push(number - 1);
      }
      const restored = new Set();
      for (const fold of saved.folds) {
        const matches = anchors.get(fold.text);
        if (saved.lines === doc.lines && matches.includes(fold.from)) restored.add(fold.from);
        else if (matches.length === 1) restored.add(matches[0]);
      }
      // Let Obsidian recalculate the fold's end from the current Markdown structure.
      if (restored.size) {
        this.native.applyFoldInfo({ lines: doc.lines, folds: [...restored].map(from => ({ from, to: from })) });
      }
    }
    this.savedFoldSnapshot = JSON.stringify(this.foldSnapshot());
    this.foldKey = key;
  }

  rememberFolds() {
    if (!this.foldKey || !this.view) return;
    const snapshot = this.foldSnapshot();
    const serialized = JSON.stringify(snapshot);
    if (serialized === this.savedFoldSnapshot) return;
    this.app.saveLocalStorage(this.foldKey, snapshot.folds.length ? snapshot : null);
    this.savedFoldSnapshot = serialized;
  }

  updateTaskProgress({ closed, total }) {
    if (this.plugin.isLinkedRollupTask(this.owner?.file)) return;
    if (!total && !this.hadDescriptionTasks) return;
    this.hadDescriptionTasks ||= total > 0;
    const surface = this.sec.closest(".pm-te-surface");
    const icon = surface?.querySelector(".pm-prop-row .lucide-percent");
    const label = icon?.closest(".pm-prop-row")?.querySelector(".pm-prop-inline-label");
    const text = progressPercent(closed, total) + "%";
    if (label && label.textContent !== text) {
      this.progressLabel ||= { element: label, text: label.textContent };
      label.textContent = text;
    }
  }

  addResizeHandle(box, horizontal = false) {
    const { view } = this;
    const handle = box.ownerDocument.createElement("div");
    const resizeClass = horizontal ? "dotpm-live-width-resized" : "dotpm-live-native-resized";
    const sizeProperty = horizontal ? "--dotpm-live-modal-width" : "height";
    const setting = horizontal ? "descriptionWidth" : "descriptionHeight";
    const measure = () => horizontal ? box.offsetWidth : box.offsetHeight;
    const coordinate = event => horizontal ? event.clientX : event.clientY;
    const dimension = horizontal ? "width" : "height";
    handle.className = horizontal ? "dotpm-live-resize-handle dotpm-live-width-handle" : "dotpm-live-resize-handle";
    handle.tabIndex = 0;
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", horizontal ? "vertical" : "horizontal");
    handle.setAttribute("aria-label", horizontal ? "调整任务弹窗宽度" : "调整描述框高度");
    handle.title = horizontal ? "左右拖动调整宽度，双击恢复默认宽度" : "上下拖动调整高度，双击恢复默认高度";
    box.appendChild(handle);
    handle.addEventListener("dblclick", event => {
      event.preventDefault();
      box.classList.remove(resizeClass);
      box.style.removeProperty(sizeProperty);
      view.requestMeasure();
      this.plugin.rememberDescriptionSize(setting, null);
    });

    const resize = size => {
      box.classList.add(resizeClass);
      box.style.setProperty(sizeProperty, Math.max(0, Math.round(size)) + "px");
      view.requestMeasure();
    };
    const remembered = this.plugin.settings[setting];
    if (horizontal && !box.classList.contains(resizeClass) && Number.isFinite(remembered) && remembered > 0) {
      resize(remembered);
    }
    let drag;
    const stopDrag = () => {
      drag?.abort();
      drag = null;
      handle.classList.remove("is-dragging");
    };
    this.resizeCleanup ||= [];
    this.resizeCleanup.push(() => {
      stopDrag();
      handle.remove();
    });
    handle.addEventListener("pointerdown", event => {
      if (event.button !== 0 || drag) return;
      event.preventDefault();
      const { pointerId } = event;
      const origin = coordinate(event);
      const size = measure();
      const scale = box.getBoundingClientRect()[dimension] / size || 1;
      // The modal stays centered, so half the width change moves its right edge.
      const multiplier = horizontal ? 2 : 1;
      drag = new AbortController();
      const options = { capture: true, signal: drag.signal };
      const finish = next => {
        if (next.pointerId !== pointerId) return;
        stopDrag();
        if (next.type === "pointerup" && measure() !== size) {
          this.plugin.rememberDescriptionSize(setting, measure());
        }
      };
      this.win.addEventListener("pointermove", next => {
        if (next.pointerId === pointerId) resize(size + (coordinate(next) - origin) * multiplier / scale);
      }, options);
      this.win.addEventListener("pointerup", finish, options);
      this.win.addEventListener("pointercancel", finish, options);
      handle.addEventListener("lostpointercapture", finish, options);
      handle.setPointerCapture(pointerId);
      handle.classList.add("is-dragging");
    });
    handle.addEventListener("keydown", event => {
      const decrease = horizontal ? "ArrowLeft" : "ArrowUp";
      const increase = horizontal ? "ArrowRight" : "ArrowDown";
      if (event.key !== decrease && event.key !== increase) return;
      event.preventDefault();
      event.stopPropagation();
      const size = measure();
      resize(size + (event.key === increase ? 24 : -24));
      if (measure() !== size) this.plugin.rememberDescriptionSize(setting, measure());
    });
  }

  expose() {
    this.plugin.activeLive2 = this;
    this.win.__dotpmLiveEditor = {
      mode: "nofile",
      getValue: () => this.view?.state.doc.toString() || "",
      contextBefore: (n = 64) => {
        if (!this.view) return "";
        const { doc, selection } = this.view.state;
        const head = selection.main.head;
        return doc.sliceString(Math.max(0, head - n), head);
      },
      insertAtCursor: (text, back = 0, range) => {
        if (!this.view?.dom.isConnected) return false;
        const selection = this.view.state.selection.main;
        const from = range?.start ?? (back ? Math.max(0, selection.head - back) : selection.from);
        const to = range?.end ?? (back ? selection.head : selection.to);
        this.view.dispatch({
          changes: { from, to, insert: text },
          selection: { anchor: from + text.length },
          userEvent: "input",
        });
        return true;
      },
      caretOffset: () => this.view?.state.selection.main.head || 0,
      focus: () => this.view?.focus(),
      ensureCheckboxAtCursor: () => {
        try {
          const v = this.view;
          if (!v) return;
          const doc = v.state.doc;
          const line = doc.lineAt(v.state.selection.main.head);
          if (/^\s*(?:[-*+]|\d+\.)\s+\[[ xX]\]/.test(line.text)) return;
          if (!line.text.trim()) return;
          const insert = "- [ ] ";
          this.syncing = true;
          v.dispatch({ changes: { from: line.from, insert }, selection: { anchor: v.state.selection.main.head + insert.length } });
          this.syncing = false;
          this.flush();
        } catch (e) { this.syncing = false; }
      },
      setCursor: (pos) => {
        try {
          const v = this.view;
          if (!v) return;
          const len = v.state.doc.length;
          const p = Math.max(0, Math.min(len, pos === undefined ? len : pos));
          v.dispatch({ selection: { anchor: p } });
        } catch (e) {}
      },
      caretCoords: () => {
        if (!this.view?.dom.isConnected) return null;
        const coords = this.view.coordsAtPos(this.view.state.selection.main.head);
        if (coords) return { left: coords.left, top: coords.top, bottom: coords.bottom };
        const host = this.host.getBoundingClientRect();
        return { left: host.left + 8, top: host.top + 8, bottom: host.top + 26 };
      },
      setValue: (value) => {
        this.pushToView(value);
        this.flush();
      },
      isActive: () => !!this.view?.dom.isConnected,
    };
  }

  pushToView(text) {
    if (!this.view || text === this.view.state.doc.toString()) return;
    this.syncing = true;
    try {
      this.native.set(text);
    } finally {
      this.syncing = false;
    }
  }


  flush() {
    if (this.syncing || !this.ta.isConnected) return;
    const value = this.view.state.doc.toString();
    if (this.ta.value === value) return;
    this.syncing = true;
    try {
      this.ta.value = value;
      // The caret belongs to the embedded editor. Keep the hidden textarea
      // from opening a second QuickAdd date picker on a synthetic input.
      this.ta.setSelectionRange(0, 0);
      this.ta.dispatchEvent(new this.win.Event("input", { bubbles: true }));
    } finally {
      this.syncing = false;
    }
  }

  async saveAttachment(name, data) {
    const pending = (this.plugin.attachmentQueue || Promise.resolve()).then(() => this.writeAttachment(name, data));
    this.plugin.attachmentQueue = pending.catch(error => {
      console.error("[dotpm-live-desc] Could not save attachment", error);
      new Notice("无法保存任务附件。");
      return null;
    });
    return this.plugin.attachmentQueue;
  }

  async writeAttachment(name, data) {
    const context = this.owner.file;
    if (!context) {
      new Notice("无法确定任务的附件保存位置。");
      return null;
    }
    if (!this.view?.dom.isConnected) return null;
    // Resolve against the task even if focus moves while the clipboard file is read.
    const path = await this.app.fileManager.getAvailablePathForAttachment(name, context.path);
    if (!this.view?.dom.isConnected) return null;
    return this.app.vault.createBinary(path, data);
  }

  releaseActiveEditor() {
    if (this.shortcutScope) {
      this.app.keymap.popScope(this.shortcutScope);
      this.shortcutScope = null;
    }
    const workspace = this.app.workspace;
    if (this.owner && workspace.activeEditor === this.owner) {
      workspace.activeEditor = this.previousEditor || null;
    }
    this.previousEditor = null;
  }

  destroy() {
    this.win.clearTimeout(this.dateTimer);
    this.rememberFolds();
    this.resizeCleanup?.forEach(cleanup => cleanup());
    if (this.progressLabel) this.progressLabel.element.textContent = this.progressLabel.text;
    this.releaseActiveEditor();
    this.ta.removeEventListener("input", this.onTaInput);
    this.view?.contentDOM.removeEventListener("focus", this.onFocus);
    this.view?.contentDOM.removeEventListener("blur", this.onBlur);
    this.host?.removeEventListener("keydown", this.onKeyDown, true);
    this.host?.removeEventListener("drop", this.onDrop);
    this.sec.removeEventListener("drop", this.onSectionDrop, true);
    try {
      this.native?.unload();
      this.native?.destroy();
    } finally {
      this.view = null;
      this.host?.remove();
      this.sec.classList.remove("dotpm-live-native-mounted");
      if (this.plugin.activeLive2 === this) {
        this.plugin.activeLive2 = null;
        this.win.__dotpmLiveEditor = null;
        const other = [...this.plugin.live2Bindings.values()].reverse()
          .find(binding => binding !== this && binding.win === this.win && binding.view?.dom.isConnected);
        other?.expose();
      }
    }
  }
}

class DotpmLiveSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Enable live preview in dotpm description")
      .setDesc("关闭后立即还原 dotpm 原始编辑体验。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enabled).onChange(async (v) => {
          this.plugin.settings.enabled = v;
          await this.plugin.saveSettings();
          this.plugin.refresh();
        })
      );

    new Setting(containerEl)
      .setName("高对比任务配色")
      .setDesc("为普通笔记和 dotpm 任务描述中的复选框及时间标记启用内置配色。")
      .addToggle(toggle => toggle.setValue(this.plugin.settings.highContrastPalette).onChange(async value => {
        this.plugin.settings.highContrastPalette = value;
        this.plugin.applyPalette();
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("显示进行中耗时")
      .setDesc("默认关闭。任务仍会累计耗时，搁置、完成和取消时显示结果。")
      .addToggle(toggle => toggle.setValue(this.plugin.settings.showRunningTime)
        .onChange(value => this.plugin.setRunningTimeOptions({ showRunningTime: value })));

    new Setting(containerEl)
      .setName("实时耗时刷新频率")
      .setDesc("开启“显示进行中耗时”时生效。耗时显示仍按分钟四舍五入。")
      .addDropdown(dropdown => dropdown.addOptions(RUNNING_TIME_FREQUENCIES)
        .setValue(String(this.plugin.settings.runningTimeRefreshSeconds))
        .onChange(value => this.plugin.setRunningTimeOptions({ runningTimeRefreshSeconds: Number(value) })));

    new Setting(containerEl)
      .setName("Mode")
      .setDesc("preview：源码 + 实时渲染预览（稳定）；live：嵌入 Obsidian 原生 Live Preview 编辑器（实验性）。")
      .addDropdown((d) =>
        d
          .addOption("preview", "preview 源码 + 实时预览")
          .addOption("live", "live 嵌入 Live Preview 编辑器（v0.2 借 scratch 文件）")
          .addOption("live2", "live2 原生嵌入编辑器（v0.4）")
          .setValue(this.plugin.settings.mode || "preview")
          .onChange(async (v) => {
            this.plugin.settings.mode = v;
            await this.plugin.saveSettings();
            this.plugin.unmountAll();
            this.plugin.refresh();
          })
      );

    new Setting(containerEl)
      .setName("Layout")
      .setDesc("源码与预览的相对位置。")
      .addDropdown((d) =>
        d
          .addOption("side", "左右分栏")
          .addOption("below", "上下排列")
          .setValue(this.plugin.settings.layout)
          .onChange(async (v) => {
            this.plugin.settings.layout = v;
            await this.plugin.saveSettings();
            this.plugin.unmountAll();
            this.plugin.refresh();
          })
      );

    new Setting(containerEl)
      .setName("Max preview height")
      .setDesc("预览区最大高度（像素）。")
      .addSlider((s) =>
        s
          .setLimits(120, 600, 20)
          .setValue(this.plugin.settings.maxHeight)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.maxHeight = v;
            await this.plugin.saveSettings();
            document.querySelectorAll(".dotpm-ld-pane, .dotpm-live-editor-host").forEach((p) => (p.style.maxHeight = v + "px"));
          })
      );

    new Setting(containerEl)
      .setName("Show badge")
      .setDesc("在预览区顶部显示 Live Preview 标记。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showBadge).onChange(async (v) => {
          this.plugin.settings.showBadge = v;
          await this.plugin.saveSettings();
          this.plugin.unmountAll();
          this.plugin.refresh();
        })
      );
  }
}


// Existing date picker, bundled with plugin-owned startup and cleanup.
// QuickAdd User Script（Run on startup）
// 在光标处插入日期，或右键已有日期原位修改。
async function installDatePicker({ plugin, app, obsidian }) {
    const { Notice } = obsidian;
    let disposed = false;
    let currentPopover = null;
    window.__dotpmDateUIDispose?.();

    window.__dotpmDateUI_observer?.disconnect();
    delete window.__dotpmDateUI_observer;
    if (window.__dotpmDateUI_keydown) document.removeEventListener("keydown", window.__dotpmDateUI_keydown, true);
    document.querySelectorAll('button[aria-label="插入日期时间"]').forEach((b) => b.remove());
    document.querySelectorAll(".pm-modal-desc-section").forEach((s) => delete s.dataset.dotpmDateBtn);
    window.__dotpmDateUI = "v93";

    const CSS = ".dotpm-dm-pop{position:absolute;z-index:calc(var(--layer-modal,50) + 100);background:var(--background-primary);border:1px solid var(--background-modifier-border);border-radius:14px;box-shadow:0 18px 44px rgba(0,0,0,.16),0 2px 8px rgba(0,0,0,.05);padding:9px 11px;box-sizing:border-box;font-size:12px;display:flex;flex-direction:column;gap:7px;animation:dotpm-in .2s cubic-bezier(.2,.9,.3,1.2) both;transform-origin:100% 100%;}.dotpm-dm-body{display:flex;gap:12px;align-items:flex-start;}.dotpm-dm-cal{user-select:none;width:246px;display:flex;flex-direction:column;gap:3px;}.dotpm-dm-head{display:flex;align-items:center;gap:3px;}.dotpm-dm-month{flex:1;text-align:center;font-size:12.5px;font-weight:600;color:var(--text-normal);letter-spacing:.2px;}button.dotpm-dm-nav{height:22px;width:22px;min-width:22px;padding:0;border:none;background:transparent;color:var(--text-muted);border-radius:6px;cursor:pointer;box-shadow:none;display:flex;align-items:center;justify-content:center;transition:background .12s,color .12s;}button.dotpm-dm-nav:hover{background:var(--background-modifier-hover);color:var(--text-normal);box-shadow:none;}button.dotpm-dm-nav svg{width:15px;height:15px;}.dotpm-dm-week{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;text-align:center;color:var(--text-muted);font-size:10.5px;margin-top:2px;font-weight:500;}.dotpm-dm-grid{user-select:none;display:grid;grid-template-columns:repeat(7,1fr);gap:2px;}button.dotpm-dm-day{height:26px;padding:0;border:none;background:transparent;border-radius:7px;font-size:11.5px;color:var(--text-normal);cursor:pointer;box-shadow:none;transition:background .12s,color .12s,transform .06s;font-variant-numeric:tabular-nums;}button.dotpm-dm-day:hover{background:var(--background-modifier-hover);box-shadow:none;transform:scale(1.06);}button.dotpm-dm-day:active{transform:scale(.94);}button.dotpm-dm-day.is-outside{color:var(--text-faint);opacity:.42;}button.dotpm-dm-day.is-today{box-shadow:inset 0 0 0 1px var(--background-modifier-border);}button.dotpm-dm-day.is-selected{background:var(--interactive-accent);color:var(--text-on-accent);font-weight:600;box-shadow:0 2px 8px color-mix(in srgb,var(--interactive-accent) 32%,transparent);animation:dotpm-daypop .24s cubic-bezier(.2,.9,.3,1.4) both;}button.dotpm-dm-day.is-start{box-shadow:inset 0 0 0 1.5px var(--interactive-accent);color:var(--interactive-accent);font-weight:600;background:transparent;animation:dotpm-daypop .24s cubic-bezier(.2,.9,.3,1.4) both;}button.dotpm-dm-day.is-end{background:var(--interactive-accent);color:var(--text-on-accent);font-weight:600;box-shadow:0 2px 8px color-mix(in srgb,var(--interactive-accent) 32%,transparent);animation:dotpm-daypop .24s cubic-bezier(.2,.9,.3,1.4) both;}button.dotpm-dm-day.is-range{background:color-mix(in srgb,var(--interactive-accent) 12%,transparent);color:var(--text-normal);border-radius:0;}button.dotpm-dm-day.is-range:hover{background:color-mix(in srgb,var(--interactive-accent) 20%,transparent);}.dotpm-dm-side{width:252px;display:flex;flex-direction:column;justify-content:space-between;align-self:stretch;}.dotpm-dm-group{display:flex;flex-direction:column;gap:6px;}.dotpm-dm-seg{position:relative;display:flex;gap:2px;background:var(--background-secondary);border-radius:8px;padding:2px;}.dotpm-dm-seg-thumb{position:absolute;top:2px;left:2px;width:calc(50% - 1px);height:24px;border-radius:6px;background:var(--interactive-accent);box-shadow:0 1px 5px color-mix(in srgb,var(--interactive-accent) 42%,transparent);transition:transform .26s cubic-bezier(.2,.9,.3,1.25),background .2s;}.dotpm-dm-seg-thumb.is-pending{background:color-mix(in srgb,var(--interactive-accent) 15%,transparent);box-shadow:none;}button.dotpm-dm-seg-btn{position:relative;z-index:1;flex:1 1 0;height:24px;border:none;background:transparent;color:var(--text-muted);border-radius:6px;font-size:11px;font-weight:500;cursor:pointer;box-shadow:none;transition:color .2s,transform .12s,background .18s cubic-bezier(.2,.9,.3,1.2);display:flex;align-items:center;justify-content:center;}button.dotpm-dm-seg-btn:hover{color:var(--text-normal);box-shadow:none;}button.dotpm-dm-seg-btn:active{transform:scale(.97);}button.dotpm-dm-seg-btn.is-on{background:transparent;color:var(--text-on-accent);box-shadow:none;}button.dotpm-dm-seg-btn.is-pending{color:var(--interactive-accent);}.dotpm-dm-timerow{display:flex;align-items:center;gap:6px;}.dotpm-dm-check{display:flex;align-items:center;gap:4px;color:var(--text-muted);font-size:11px;white-space:nowrap;cursor:pointer;height:24px;}.dotpm-dm-timerow input[data-role=time]{flex:1 1 auto;min-width:0;border:none;background:var(--background-secondary);border-radius:6px;padding:0 6px;height:24px;font-family:inherit;font-size:11px;font-variant-numeric:tabular-nums;color:var(--text-normal);box-shadow:none;}.dotpm-dm-timerow select{flex:0 0 58px;height:24px;border:none;background:var(--background-secondary);border-radius:6px;padding:0 4px;font-family:inherit;font-size:11px;color:var(--text-muted);box-shadow:none;cursor:pointer;font-variant-numeric:tabular-nums;}.dotpm-dm-timerow select:disabled{opacity:.38;cursor:default;}.dotpm-dm-snap{display:flex;align-items:stretch;background:var(--background-secondary);border-radius:6px;overflow:hidden;height:24px;}button.dotpm-dm-snap-main{flex:1 1 auto;border:none;background:transparent;color:var(--text-muted);font-size:10.5px;font-weight:500;cursor:pointer;padding:0 4px;box-shadow:none;transition:background .12s,color .12s;}button.dotpm-dm-snap-main:hover{color:var(--text-normal);background:var(--background-modifier-hover);box-shadow:none;}button.dotpm-dm-snap-step{flex:0 0 auto;border:none;border-left:1px solid var(--background-modifier-border);background:transparent;color:var(--text-faint);font-size:10px;cursor:pointer;padding:0 5px;box-shadow:none;font-family:inherit;font-variant-numeric:tabular-nums;}button.dotpm-dm-snap-step:hover{color:var(--text-normal);background:var(--background-modifier-hover);box-shadow:none;}.dotpm-dm-snap button:disabled{opacity:.38;pointer-events:none;}.dotpm-dm-chips{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;}.dotpm-dm-chips--4{grid-template-columns:repeat(4,1fr);}.dotpm-dm-timesteps{grid-template-columns:repeat(4,1fr);}button.dotpm-dm-chip{height:24px;box-shadow:none;border:none;background:var(--background-secondary);color:var(--text-muted);border-radius:6px;padding:0 2px;font-size:10.5px;font-weight:500;cursor:pointer;white-space:nowrap;transition:background .12s,color .12s,transform .06s;animation:dotpm-rise .22s cubic-bezier(.2,.9,.3,1.2) both;}button.dotpm-dm-chip:nth-child(2){animation-delay:.02s}button.dotpm-dm-chip:nth-child(3){animation-delay:.04s}button.dotpm-dm-chip:nth-child(4){animation-delay:.06s}button.dotpm-dm-chip:nth-child(5){animation-delay:.08s}button.dotpm-dm-chip:nth-child(6){animation-delay:.1s}button.dotpm-dm-chip:hover{background:var(--background-modifier-hover);color:var(--text-normal);box-shadow:none;}button.dotpm-dm-chip:active{transform:scale(.95);}button.dotpm-dm-chip.dotpm-dm-chip--mono{font-family:var(--font-monospace);}button.dotpm-dm-chip:disabled{opacity:.38;cursor:default;pointer-events:none;}.dotpm-dm-bottom{display:flex;align-items:center;gap:8px;}.dotpm-dm-preview{flex:1 1 auto;min-width:0;font-family:var(--font-monospace);font-size:11.5px;line-height:1.4;color:var(--text-muted);background:var(--background-secondary);border-radius:7px;padding:5px 9px;white-space:nowrap;overflow-x:auto;overflow-y:hidden;}.dotpm-dm-preview.is-flash{animation:dotpm-flash .45s ease-out;}.dotpm-dm-footer{display:flex;justify-content:flex-end;align-items:center;gap:6px;flex:0 0 auto;}button.dotpm-dm-primary{background:var(--interactive-accent);color:var(--text-on-accent);border:none;border-radius:7px;padding:5px 18px;font-size:11.5px;font-weight:600;cursor:pointer;box-shadow:0 2px 10px color-mix(in srgb,var(--interactive-accent) 30%,transparent);transition:transform .12s ease,box-shadow .18s ease;}button.dotpm-dm-primary:hover{background:var(--interactive-accent-hover);color:var(--text-on-accent);transform:translateY(-1px);box-shadow:0 6px 18px color-mix(in srgb,var(--interactive-accent) 34%,transparent);}button.dotpm-dm-primary:active{transform:scale(.97);}button.dotpm-dm-ghost{background:transparent;border:none;color:var(--text-muted);font-size:11.5px;cursor:pointer;box-shadow:none;padding:5px 10px;border-radius:7px;}button.dotpm-dm-ghost:hover{color:var(--text-normal);background:var(--background-modifier-hover);box-shadow:none;}@keyframes dotpm-in{0%{opacity:0;transform:translateY(8px) scale(.96)}60%{opacity:1;transform:translateY(-1px) scale(1.004)}100%{opacity:1;transform:none}}@keyframes dotpm-rise{0%{opacity:0;transform:translateY(5px)}100%{opacity:1;transform:none}}@keyframes dotpm-daypop{0%{transform:scale(.82)}55%{transform:scale(1.08)}100%{transform:scale(1)}}@keyframes dotpm-flash{0%{background:color-mix(in srgb,var(--interactive-accent) 20%,var(--background-secondary))}100%{background:var(--background-secondary)}}@media (prefers-reduced-motion:reduce){.dotpm-dm-pop,button.dotpm-dm-chip,button.dotpm-dm-day,.dotpm-dm-preview{animation:none!important;transition:none!important;}}";
    const ensureStyles = () => {
        let st = document.getElementById("dotpm-dm-style");
        if (!st) { st = document.createElement("style"); st.id = "dotpm-dm-style"; document.head.appendChild(st); }
        st.textContent = CSS;
    };

    const pad = (n) => String(n).padStart(2, "0");
    const snapDate = (d, step) => {
        const o = new Date(d.getTime());
        o.setSeconds(0, 0);
        if (!step) return o;
        const t = o.getHours() * 60 + o.getMinutes();
        o.setHours(0, 0, 0, 0);
        o.setMinutes(Math.round(t / step) * step);
        return o;
    };
    const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const dstr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const sameDay = (x, y) => x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
    const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

    // ── 使用习惯记忆（带时间 / 步长）
    const PREF_KEY = "dotpm-date-ui-prefs";
    const loadPrefs = () => {
        try {
            const v = app.loadLocalStorage ? app.loadLocalStorage(PREF_KEY) : window.localStorage.getItem(PREF_KEY);
            if (!v) return {};
            return typeof v === "string" ? JSON.parse(v) : v;
        } catch (e) { return {}; }
    };
    const savePrefs = (patch) => {
        try {
            const next = Object.assign({}, loadPrefs(), patch);
            if (app.saveLocalStorage) app.saveLocalStorage(PREF_KEY, next);
            else window.localStorage.setItem(PREF_KEY, JSON.stringify(next));
        } catch (e) {}
    };

    const taskModal = () => {
        const all = [...document.querySelectorAll(".pm-modal--task, .pm-task-detail:not([hidden])")].filter((m) => m.isConnected);
        const visible = all.filter((m) => m.offsetParent !== null);
        const list = visible.length ? visible : all;
        return list.length ? list[list.length - 1] : null;
    };
    const descBox = () => {
        const ae = document.activeElement;
        if (ae && ae.tagName === "TEXTAREA" && ae.classList.contains("pm-modal-description")) return ae;
        const m = taskModal();
        return m ? m.querySelector("textarea.pm-modal-description") : null;
    };
    const popover = () => document.querySelector(".dotpm-dm-pop");

    // 让描述框保持可见、聚焦（dotpm 会在失焦后切回预览态）
    const ensureEditing = (root) => {
        const scope = root || taskModal();
        const ta = (scope && scope.querySelector("textarea.pm-modal-description")) || descBox();
        if (!ta) return null;
        const host = ta.parentElement;
        const prev = host && host.querySelector(".pm-modal-desc-preview");
        if (ta.classList.contains("pm-hidden")) {
            if (prev) prev.classList.add("pm-hidden");
            ta.classList.remove("pm-hidden");
        }
        try { ta.focus({ preventScroll: true }); } catch (e) {}
        return ta;
    };

    let caret = null;
    const onSelectionChange = () => {
        const el = document.activeElement;
        if (el && el.tagName === "TEXTAREA" && el.classList.contains("pm-modal-description")) {
            caret = { start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0 };
        }
    };
    document.addEventListener("selectionchange", onSelectionChange);

    const DATE_TOKEN = /[*_`]?@?\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?(?:[–~—-](?:\d{4}-\d{2}-\d{2})?(?:[ T]?\d{2}:\d{2})?)?[*_`]?/g;
    const dateSelection = (value, start, valueOnly = false) => {
        const dates = value.match(/\d{4}-\d{2}-\d{2}/g) || [];
        const times = value.match(/\d{2}:\d{2}/g) || [];
        if (!dates.length) return null;
        const startValue = dates[0] + (times[0] ? " " + times[0] : "");
        if (!valueOnly && value.startsWith("~")) {
            return { start, end: start + value.length, hasTime: times.length > 0, startValue: "", endValue: startValue, deadlineOnly: true };
        }
        let endValue = "";
        if (dates.length > 1) endValue = dates[1] + (times[1] ? " " + times[1] : "");
        else if (times.length > 1) endValue = dates[0] + " " + times[1];
        return { start, end: start + value.length, hasTime: times.length > 0, startValue, endValue, valueOnly };
    };

    const detectAtCaret = (text, pos) => {
        const includesCaret = match => match.index <= pos && pos <= match.index + match[0].length;
        const marker = [...text.matchAll(TIME_MARKER)].find(includesCaret);
        if (marker) {
            const dateStart = marker.index + marker[0].indexOf(marker[2], marker[0].indexOf("@"));
            if (marker[1] === "计划") {
                return { ...dateSelection(marker[2], dateStart), start: marker.index, end: marker.index + marker[0].length };
            }
            const resumeStart = marker[3] ? marker.index + marker[0].indexOf(marker[3], marker[0].lastIndexOf("@")) : 0;
            if (marker[3] && pos >= marker.index + marker[0].lastIndexOf("@")) return dateSelection(marker[3], resumeStart, true);
            return dateSelection(marker[2], dateStart, true);
        }
        const legacy = [...text.matchAll(InlineTaskState.STATE_SPAN)].find(includesCaret);
        if (legacy) {
            const bodyStart = legacy.index + legacy[0].indexOf(">") + 1;
            const body = legacy[0].slice(bodyStart - legacy.index);
            const date = /\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?/.exec(body);
            if (date) return dateSelection(date[0], bodyStart + date.index, true);
        }
        const date = [...text.matchAll(DATE_TOKEN)].find(includesCaret);
        return date ? dateSelection(date[0], date.index) : null;
    };


    // Local, deterministic date input. Unknown text is rejected instead of silently discarded.
    const parsePickerInput = (source, anchor, selectedDate) => {
        let text = source.normalize("NFKC").trim().toLowerCase().replace(/[，,]/g, " ").replace(/[～〜]/g, "~");
        text = text.replace(/半小时(后|前)/g, "30分钟$1")
            .replace(/([零〇一二两三四五六七八九十]{1,3})(?=点|时|分|天|月|日|号)/g, word => {
                const digit = character => ({ 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 })[character];
                if (word.includes("十")) {
                    const [tens, ones] = word.split("十");
                    return String((tens ? digit(tens) : 1) * 10 + (ones ? digit(ones) : 0));
                }
                return word.length === 1 ? String(digit(word)) : word;
            });
        let deadline = false;
        if (/^\{.*\}$/.test(text)) { deadline = true; text = text.slice(1, -1).trim(); }
        if (/^(?:截止(?:日期)?|deadline|due)\s*/.test(text)) {
            deadline = true;
            text = text.replace(/^(?:截止(?:日期)?|deadline|due)\s*/, "");
        }
        if (text.startsWith("~")) { deadline = true; text = text.slice(1).trim(); }
        let duration = 0;
        const durationMatch = /(?:\s+(?:持续\s*)?|\s*持续\s*)((?:\d+(?:h|小时))?(?:\d+(?:m|分钟|分))?|半小时)\s*$/.exec(text);
        if (durationMatch && durationMatch[1]) {
            const value = durationMatch[1];
            const hours = /(\d+)(?:h|小时)/.exec(value);
            const minutes = /(\d+)(?:m|分钟|分)/.exec(value);
            duration = value === "半小时" ? 30 : Number(hours?.[1] || 0) * 60 + Number(minutes?.[1] || 0);
            if (!duration || duration > 10080) return { error: "持续时长需在 1 分钟到 7 天之间" };
            text = text.slice(0, durationMatch.index).trim();
        }
        text = text.replace(/(?:至|到|→)/g, "~")
            .replace(/(\d{1,2}:\d{2})\s*-\s*(?=\d{1,2}:\d{2})/g, "$1~")
            .replace(/(\d{1,2}(?:点|时)(?:半|\d{1,2}分?)?)\s*-\s*(?=\d)/g, "$1~");
        const chunks = text.split("~").map(value => value.trim());
        if (chunks.length > 2 || chunks.some(value => !value) || (deadline && (chunks.length !== 1 || duration))) return { error: "请输入单个日期，或用 到 / ~ 分隔起止时间" };
        const parsePoint = (value, inherited) => {
            let rest = value.trim();
            let date = new Date(inherited?.date || selectedDate);
            let explicitDate = false, hasTime = false, period = null;
            const today = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate(), 9);
            const setDay = day => { date = new Date(day); explicitDate = true; };
            const relativeTime = /^(\d+)\s*(分钟|分|小时|时|m|h)(后|前)$/.exec(rest);
            if (relativeTime) {
                const amount = Number(relativeTime[1]) * (/小时|时|h/.test(relativeTime[2]) ? 60 : 1);
                if (amount > 525600) return null;
                return { date: new Date(anchor.getTime() + amount * 60000 * (relativeTime[3] === "前" ? -1 : 1)), hasTime: true, explicitDate: true, period: null };
            }
            if (/^(现在|此刻|now)$/.test(rest)) return { date: new Date(anchor), hasTime: true, explicitDate: true, period: null };
            let match = /^(大后天|大前天|今天|今日|明天|后天|昨天|前天|today|tomorrow|yesterday)\s*/.exec(rest);
            if (match) {
                const offsets = { 大后天: 3, 大前天: -3, 今天: 0, 今日: 0, 明天: 1, 后天: 2, 昨天: -1, 前天: -2, today: 0, tomorrow: 1, yesterday: -1 };
                setDay(today); date.setDate(date.getDate() + offsets[match[1]]); rest = rest.slice(match[0].length);
            } else if ((match = /^(\d+)\s*天(后|前)\s*/.exec(rest))) {
                if (Number(match[1]) > 36600) return null;
                setDay(today); date.setDate(date.getDate() + Number(match[1]) * (match[2] === "后" ? 1 : -1)); rest = rest.slice(match[0].length);
            } else if ((match = /^(本|这|下|上)?(?:周|星期|礼拜)([一二三四五六日天1-7])\s*/.exec(rest))) {
                const number = "一二三四五六日天".indexOf(match[2]);
                const weekday = number >= 0 ? Math.min(number + 1, 7) : Number(match[2]);
                const shift = match[1] === "下" ? 7 : match[1] === "上" ? -7 : 0;
                setDay(today); date.setDate(date.getDate() - ((today.getDay() + 6) % 7) + weekday - 1 + shift); rest = rest.slice(match[0].length);
            } else if ((match = /^(?:(\d{4})[-/.年])?(\d{1,2})[-/.月](\d{1,2})(?:日|号)?(?!\d)\s*/.exec(rest))) {
                const year = match[1] ? Number(match[1]) : anchor.getFullYear(), month = Number(match[2]), day = Number(match[3]);
                const candidate = new Date(year, month - 1, day, 9);
                if (candidate.getFullYear() !== year || candidate.getMonth() !== month - 1 || candidate.getDate() !== day) return null;
                setDay(candidate); rest = rest.slice(match[0].length);
            }
            rest = rest.trim().replace(/^(?:at|t)\s*/, "");
            const prefix = /^(凌晨|早上|上午|中午|下午|晚上|晚间)\s*/.exec(rest);
            if (prefix) { period = /下午|晚上|晚间/.test(prefix[1]) ? "pm" : prefix[1] === "中午" ? "noon" : "am"; rest = rest.slice(prefix[0].length); if (!rest && period === "noon") rest = "12:00"; }
            if (/^(中午|noon)$/.test(rest)) { rest = "12:00"; period = "noon"; }
            if (/^\d{3,4}$/.test(rest)) rest = rest.slice(0, -2) + ":" + rest.slice(-2);
            const time = /^(\d{1,2})(?:(?::|点|时)(?:(\d{1,2})(?:分)?|(半|一刻|三刻))?)?\s*(am|pm)?$/.exec(rest);
            if (rest && !time) return null;
            if (time) {
                let hour = Number(time[1]), minute = Number(time[2] || (time[3] === "半" ? 30 : time[3] === "一刻" ? 15 : time[3] === "三刻" ? 45 : 0));
                const explicitPeriod = time[4] || period;
                period = explicitPeriod || inherited?.period || null;
                if (hour > 23 || minute > 59) return null;
                if (period && hour > 12) {
                    if (!explicitPeriod || period === "pm" || period === "noon") period = null;
                    else return null;
                }
                if (period === "pm") hour = hour % 12 + 12;
                else if (period === "am") hour %= 12;
                else if (period === "noon" && hour < 11) hour += 12;
                date.setHours(hour, minute, 0, 0); hasTime = true;
            } else {
                if (!explicitDate || period) return null;
                date.setHours(9, 0, 0, 0);
            }
            date.setSeconds(0, 0);
            return { date, hasTime, explicitDate, period };
        };
        const first = parsePoint(chunks[0]);
        if (!first) return { error: "尚未识别，可试：明天下午3点、下周一9:30、11/25 14:00" };
        let last = chunks.length === 2 ? parsePoint(chunks[1], first) : null;
        if (chunks.length === 2 && (!last || last.hasTime !== first.hasTime)) return { error: "请补全起止时间，并保持两端格式一致" };
        if (last && last.date < first.date) {
            if (last.hasTime && !last.explicitDate) last.date.setDate(last.date.getDate() + 1);
            else return { error: "结束不能早于开始" };
        }
        if (duration) {
            if (last || !first.hasTime) return { error: "时长需跟在单个具体时刻后，例如：明天9点 30m" };
            last = { date: new Date(first.date.getTime() + duration * 60000), hasTime: true };
        }
        return { start: first.date, end: last?.date || null, withTime: first.hasTime, deadline, duration };
    };

    const dateColors = { plan: "#9873F7", start: "#E68A00", done: "#2E9E66", hold: "#E05355", cancel: "#7E869B" };
    const taskDateContext = (target, pos, detected) => {
        const full = target.text();
        const from = full.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
        const newline = full.indexOf("\n", pos);
        const to = newline < 0 ? full.length : newline;
        const text = full.slice(from, to);
        if (!/^\s*(?:[-*+]|\d+[.)])\s+\[[^\]]\]/.test(text)) return null;
        const matches = [...text.matchAll(TIME_MARKER)];
        const options = matches.map(match => {
            const kind = TIME_KIND[match[1]];
            const offset = match.index + match[0].indexOf(match[2], match[0].indexOf("@"));
            return {
                kind, label: kind === "plan" ? "计划 / 截止" : InlineTaskState.STATE_LABEL[kind],
                range: kind === "plan"
                    ? { ...dateSelection(match[2], from + offset), start: from + match.index, end: from + match.index + match[0].length }
                    : { ...dateSelection(match[2], from + offset, true), taskDate: kind },
            };
        });
        const read = InlineTaskState.readState(text);
        if (read.startedAt && !options.some(option => option.kind === "start")) {
            options.splice(Math.min(1, options.length), 0, {
                kind: "start", label: "首次开始",
                range: { start: from, end: to, hasTime: true, startValue: taskTimestamp(read.startedAt), endValue: "", valueOnly: true, taskDate: "start" },
            });
        }
        if (!options.some(option => option.kind === "plan")) {
            options.unshift({ kind: "plan", label: "计划 / 截止", hasRecord: false, range: { start: to, end: to, startValue: "", endValue: "" } });
        }
        const selected = options.filter(option => detected &&
            (option.range.start <= detected.start && detected.end <= option.range.end)).sort((a, b) => (a.range.end - a.range.start) - (b.range.end - b.range.start))[0];
        return { full, from, to, text, options, selected: selected || options[0] };
    };

    const writeTaskDate = (context, kind, value) => {
        if (!context || curTarget.text() !== context.full) {
            new Notice("文本已更新，请重新打开日期选择器。");
            return false;
        }
        const parsed = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value) && Date.parse(value.replace(" ", "T"));
        if (!parsed) {
            new Notice("状态时间请保留时、分。");
            return false;
        }
        let text = context.text;
        const state = InlineTaskState.readState(text);
        const clock = TASK_CLOCK.exec(text);
        const current = [...text.matchAll(TIME_MARKER)].findLast(match => match[1] !== "计划");
        const oldStart = state.startedAt;
        const oldStamp = current && Date.parse(current[2].replace(" ", "T"));
        const newStart = kind === "start" ? parsed : oldStart;
        const newStamp = kind === "start" ? oldStamp : parsed;
        if (newStart && newStamp && state.current !== "start" && newStamp < newStart) {
            new Notice("状态时间不能早于首次开始时间。");
            return false;
        }
        if (kind === "start" && state.current === "start" && parsed > Date.now()) {
            new Notice("首次开始时间不能晚于当前时间。");
            return false;
        }
        let elapsed = Number(clock?.[2]) || 0;
        let segment = Number(clock?.[1]) || 0;
        if (kind === "start" && oldStart) {
            if (clock && state.current === "start" && segment) {
                const now = Date.now();
                elapsed = Math.max(0, elapsed + Math.max(0, now - segment) + oldStart - parsed);
                segment = now;
            } else elapsed = Math.max(0, elapsed + oldStart - parsed);
        } else if (clock && oldStamp && state.current !== "start") elapsed = Math.max(0, elapsed + parsed - oldStamp);
        if (clock) {
            if (kind !== "start" && state.current === "done") segment = parsed;
            const suffix = clock[4] ? ",auto-" + clock[4] : "";
            text = text.replace(TASK_CLOCK, " %%dotpm-clock:" + segment + "," + elapsed + "," + newStart + suffix + "%%");
        }
        if (current) {
            const stamp = state.current === "start" ? newStart : newStamp;
            const replacement = InlineTaskState.stampTime(state.current,
                newStart ? taskTimestamp(newStart) : null, stamp,
                state.current === "start" ? null : clock ? elapsed : null);
            text = text.replace(TIME_MARKER, (marker, label) => label === "计划" ? marker : replacement);
        }
        text = text.trimEnd() + " ";
        return curTarget.insert(text, context.from, context.to) !== false;
    };

    const insertText = (text, range) => {
        if (range?.taskDate) return writeTaskDate(currentPopover?.context, range.taskDate, text);
        const target = curTarget;
        if (!target) return false;
        if (currentPopover?.context && target.text() !== currentPopover.context.full) {
            new Notice("文本已更新，请重新打开日期选择器。");
            return false;
        }
        if (range?.valueOnly) {
            if (text.includes("~")) {
                new Notice("状态时间只接受单个日期或时刻。");
                return false;
            }
            return target.insert(text, range.start, range.end) !== false;
        }
        const full = target.text();
        let start = Math.max(0, Math.min(range?.start ?? target.caret(), full.length));
        let end = Math.max(start, Math.min(range?.end ?? start, full.length));
        const plans = [...full.matchAll(LEGACY_PLAN), ...[...full.matchAll(TIME_MARKER)].filter(match => match[1] === "计划")];
        for (const marker of plans) {
            const markerEnd = marker.index + marker[0].length;
            if (start >= marker.index && end < markerEnd) {
                start = marker.index;
                end = markerEnd;
                break;
            }
        }
        if (full[start - 1] === "@") start--;
        const needSpace = start > 0 && !/\s/.test(full[start - 1]);
        // Reuse an existing separator so repeated edits don't accumulate spaces.
        if (full[end] === " ") end++;
        const payload = (needSpace ? " " : "") + "计划 @ " + text + " ";
        if (target.insert(payload, start, end) === false) return false;
        if (target.kind === "hook") window.__dotpmLiveEditor?.ensureCheckboxAtCursor?.();
        caret = { start: start + payload.length, end: start + payload.length };
        return true;
    };

    const hostFor = (ta) => {
        const host = ta.closest(".pm-modal") || ta.parentElement || document.body;
        if (getComputedStyle(host).position === "static") host.style.position = "relative";
        return host;
    };

    // 光标在 host 内的坐标：用离屏镜像量出光标相对镜像左上角的偏移（不受容器定位影响）
    const caretPoint = (ta, host) => {
        if (!ta) return { left: 8, top: 8, bottom: 26 };
        const rect = ta.getBoundingClientRect();
        const hr = host.getBoundingClientRect();
        const cs = getComputedStyle(ta);
        const mirror = document.createElement("div");
        mirror.style.cssText = "position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none;box-sizing:border-box;white-space:pre-wrap;overflow-wrap:break-word;";
        mirror.style.font = cs.font;
        mirror.style.lineHeight = cs.lineHeight;
        mirror.style.padding = cs.padding;
        mirror.style.border = cs.border;
        mirror.style.width = rect.width + "px";
        mirror.textContent = ta.value.slice(0, ta.selectionStart ?? ta.value.length);
        const marker = document.createElement("span");
        marker.textContent = "\u200b";
        mirror.appendChild(marker);
        document.body.appendChild(mirror);
        const mr = marker.getBoundingClientRect();
        const mb = mirror.getBoundingClientRect();
        const lh = mr.height || parseFloat(cs.lineHeight) || 18;
        document.body.removeChild(mirror);
        const x = rect.left - hr.left + (mr.left - mb.left) - (ta.scrollLeft || 0);
        const y = rect.top - hr.top + (mr.top - mb.top) - (ta.scrollTop || 0);
        return { left: x, top: y, bottom: y + lh };
    };

    // 调试入口（也方便从控制台手动唤起）
    window.__dotpmOpenPicker = (r, a, e) => openPicker(r, a, e);
    window.__dotpmOpenDatePicker = (r) => openPicker(r, null, true);

    // 找到当前可用的 Markdown 编辑器（优先聚焦的那个）
    const editorOf = () => {
        try {
            const cands = [];
            const ea = app.workspace.activeEditor;
            if (ea && ea.editor) cands.push(ea.editor);
            const mr = app.workspace.getMostRecentLeaf && app.workspace.getMostRecentLeaf();
            if (mr && mr.view && mr.view.editor) cands.push(mr.view.editor);
            const leaves = app.workspace.getLeavesOfType ? app.workspace.getLeavesOfType("markdown") : [];
            leaves.forEach((l) => { if (l && l.view && l.view.editor) cands.push(l.view.editor); });
            const valid = cands.filter((ed) => ed && ed.cm);
            if (!valid.length) return null;
            const focused = valid.find(ed => ed.cm.hasFocus);
            return focused || valid[0];
        } catch (e) { return null; }
    };

    const mkTextareaTarget = (ta) => {
        hostFor(ta); // 保留原有副作用（确保可定位），但面板改挂到 body
        return {
            kind: "ta",
            host: ta.closest(".modal-container") || document.body,
            fixed: true,
            el: ta,
            text: () => ta.value,
            caret: () => (document.activeElement === ta ? (ta.selectionStart ?? ta.value.length) : (caret ? caret.start : ta.value.length)),
            insert: (payload, from, to) => {
                const prev = ta.parentElement && ta.parentElement.querySelector(".pm-modal-desc-preview");
                if (prev) prev.classList.add("pm-hidden");
                if (ta.classList.contains("pm-hidden")) ta.classList.remove("pm-hidden");
                try { ta.focus(); } catch (e) {}
                ta.setRangeText(payload, from, to, "end");
                ta.dispatchEvent(new Event("input", { bubbles: true }));
                ta.dispatchEvent(new Event("change", { bubbles: true }));
            },
            point: () => caretPoint(ta, document.body),
            focus: () => {
                const prev = ta.parentElement && ta.parentElement.querySelector(".pm-modal-desc-preview");
                if (prev) prev.classList.add("pm-hidden");
                if (ta.classList.contains("pm-hidden")) ta.classList.remove("pm-hidden");
                try { ta.focus({ preventScroll: true }); } catch (e) {}
            },
        };
    };

    const mkEditorTarget = (ed) => {
        const cm = ed.cm;
        return {
            kind: "cm",
            host: cm.dom.closest(".modal-container") || document.body,
            fixed: true,
            el: cm.dom,
            text: () => ed.getValue(),
            caret: () => ed.posToOffset(ed.getCursor("to")),
            insert: (payload, from, to) => {
                ed.replaceRange(payload, ed.offsetToPos(from), ed.offsetToPos(to));
                ed.setCursor(ed.offsetToPos(from + payload.length));
                try { ed.focus(); } catch (e) {}
            },
            point: () => {
                const off = ed.posToOffset(ed.getCursor("from"));
                let c = null;
                try { c = cm.coordsAtPos(off); } catch (e) {}
                if (!c) {
                    const r = cm.dom.getBoundingClientRect();
                    c = { left: r.left, top: r.top, bottom: r.top + 18 };
                }
                return { left: c.left, top: c.top, bottom: c.bottom };
            },
            focus: () => { try { ed.focus(); } catch (e) {} },
        };
    };

    let curTarget = null;

    const purgeStaleDialogs = () => {
        document.querySelectorAll(".modal-container").forEach((mc) => {
            if (!mc.querySelector(".dotpm-dm")) return;
            if (mc.querySelector(".dotpm-dm-pop")) return;
            try { mc.remove(); } catch (e) {}
        });
    };

    const openPicker = (replaceRange, anchorEl, preferEditor, preferredEditor, detectedAtPointer) => {
        purgeStaleDialogs();
        setTimeout(purgeStaleDialogs, 60);
        setTimeout(purgeStaleDialogs, 250);
        if (disposed) return;
        currentPopover?.close();

        let target = null;
        // v0.3：无文件 Live 编辑器优先
        const liveHook = window.__dotpmLiveEditor;
        if (!preferredEditor && liveHook?.isActive()) {
            target = {
                kind: "hook",
                host: plugin.activeLive2?.host?.closest(".modal-container") || document.body,
                fixed: true,
                text: () => liveHook.getValue(),
                caret: () => liveHook.caretOffset(),
                insert: (payload, from, to) => liveHook.insertAtCursor(payload, 0, { start: from, end: to }),
                point: () => liveHook.caretCoords(),
                focus: () => liveHook.focus?.(),
            };
        }
        const ta = target ? null : descBox();
        if (!target && !preferEditor && ta && ta.isConnected) target = mkTextareaTarget(ta);
        if (!target) {
            const ed = preferredEditor || editorOf();
            if (ed) target = mkEditorTarget(ed);
        }
        if (!target) { new Notice("把光标放在正文或任务描述里再用"); return; }
        curTarget = target;

        const pos = target.caret();
        let detected = detectedAtPointer || null;
        if (!detected && !replaceRange) { try { detected = detectAtCaret(target.text(), pos); } catch (e) {} }
        const context = taskDateContext(target, detected?.start ?? pos, detected);
        if (context && detected?.valueOnly) {
            const selected = context.options.filter(option => option.kind !== "plan" &&
                option.range.start <= detected.start && detected.end <= option.range.end).sort((a, b) => (a.range.end - a.range.start) - (b.range.end - b.range.start))[0];
            if (selected) { context.selected = selected; detected = selected.range; }
        }
        if (context && !detected && !replaceRange) detected = context.selected.range;
        new DatePopover(app, detected, replaceRange || null, anchorEl, context).open();
    };

    plugin.addCommand({
        id: "open-date-picker",
        name: "打开日期选择器",
        hotkeys: [{ modifiers: ["Alt"], key: "D" }],
        checkCallback: checking => {
            const editor = editorOf();
            const ordinaryEditor = editor?.cm.hasFocus && !editor.cm.dom.closest(".dotpm-live-native") ? editor : null;
            if (!editor && !descBox()) return false;
            if (!checking) openPicker(null, null, !taskModal(), ordinaryEditor);
            return true;
        },
    });

    class DatePopover {
        constructor(app, detected, replaceAt, anchorEl, context) {
            this.context = context;
            this.app = app;
            this.detected = detected || null;
            this.replaceAt = replaceAt || null;
            this.anchorEl = anchorEl || null;
            this.el = null;
            this.host = null;
            this.onDown = null;
            this.step = Number(loadPrefs().step) || 30;
        }

        parse(v) {
            if (!v) return null;
            const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(v);
            if (!m) return null;
            return new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 9, m[5] ? +m[5] : 0, 0, 0);
        }

        open() {
            if (disposed) return;
            currentPopover = this;
            ensureStyles();
            this.target = curTarget;
            this.host = (curTarget && curTarget.host) || document.body;
            this.fixed = !!(curTarget && curTarget.fixed);

            let dragging = false;
            let dragFrom = null;
            let dragTo = null;
            let suppressClick = false;

            const now = new Date();
            const readSelection = range => {
                const start = this.parse(range?.startValue);
                const end = this.parse(range?.endValue);
                const deadlineOnly = !!range?.deadlineOnly && !!end;
                const target = end && (deadlineOnly || range?.target === "end") ? "end" : "start";
                const first = deadlineOnly ? new Date(end) : start || snapDate(now, this.step);
                const active = target === "end" ? end : first;
                return {
                    start: first,
                    end,
                    withTime: range ? !!range.hasTime : loadPrefs().withTime !== false,
                    target,
                    deadlineOnly,
                    vy: active.getFullYear(),
                    vm: active.getMonth(),
                };
            };
            const st = readSelection(this.detected);

            const inputAnchor = new Date(now);
            let inputBaseDate = new Date(st.start);
            let cleared = false;
            let durationLock = 0;
            const el = document.createElement("div");
            el.className = "dotpm-dm-pop dotpm-dm-dial-layout";
            el.dataset.role = "popover";
            this.el = el;
            const context = this.context;
            let fieldRow;
            if (context) {
                fieldRow = document.createElement("div");
                fieldRow.className = "dotpm-dm-fieldrow";
                fieldRow.setAttribute("role", "group");
                fieldRow.setAttribute("aria-label", "编辑哪种时间");
                const selected = context.selected;
                el.style.setProperty("--dotpm-edit-color", dateColors[selected.kind]);
                el.dataset.editKind = selected.kind;
                for (const [kind, label] of [["plan", "计划"], ["start", "开始"], ["done", "完成"], ["hold", "搁置"], ["cancel", "取消"]]) {
                    const option = context.options.find(item => item.kind === kind);
                    const available = !!option && option.hasRecord !== false;
                    const button = document.createElement("button");
                    button.type = "button";
                    button.className = "dotpm-dm-kind";
                    button.dataset.role = "date-kind";
                    button.dataset.kind = kind;
                    button.style.setProperty("--kind-color", dateColors[kind]);
                    button.disabled = !available;
                    button.title = available ? (kind === "start" ? "编辑首次开始时间" : "编辑" + label + "时间") : "暂无" + label + "时间记录";
                    button.setAttribute("aria-pressed", String(available && kind === selected.kind));
                    const dot = document.createElement("span");
                    dot.className = "dotpm-dm-kind-dot";
                    dot.setAttribute("aria-hidden", "true");
                    button.append(dot, document.createTextNode(label));
                    button.onclick = () => {
                        if (!available || option === context.selected) return;
                        context.selected = option;
                        this.detected = option.range;
                        this.replaceAt = null;
                        Object.assign(st, readSelection(option.range));
                        cleared = false;
                        durationLock = 0;
                        el.style.setProperty("--dotpm-edit-color", dateColors[kind]);
                        el.dataset.editKind = kind;
                        for (const tab of fieldRow.children) {
                            tab.setAttribute("aria-pressed", String(tab === button));
                        }
                        render();
                        if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
                            for (const node of [resultOutput, grid]) {
                                node.getAnimations().forEach(animation => animation.cancel());
                                node.animate([{ opacity: 0.65 }, { opacity: 1 }], { duration: 150, easing: "ease-out" });
                            }
                        }
                    };
                    fieldRow.append(button);
                }
            }
            const bodyEl = document.createElement("div");
            bodyEl.className = "dotpm-dm-body";
            const cal = document.createElement("div");
            cal.className = "dotpm-dm-cal";
            const side = document.createElement("div");
            side.className = "dotpm-dm-side";
            side.inert = true;
            side.id = "dotpm-dm-time-panel";
            const gTime = document.createElement("div");
            gTime.className = "dotpm-dm-group dotpm-dm-time-group";
            const gDates = document.createElement("div");
            gDates.className = "dotpm-dm-group dotpm-dm-date-group";
            const gSteps = document.createElement("div");
            gSteps.className = "dotpm-dm-group";
            const dateColumn = document.createElement("div");
            dateColumn.className = "dotpm-dm-date-column";
            if (fieldRow) dateColumn.append(fieldRow);
            dateColumn.append(cal);
            bodyEl.append(dateColumn, side);
            el.appendChild(bodyEl);

            // 头部：‹ 月份 › + 目标
            const head = document.createElement("div");
            head.className = "dotpm-dm-head";
            const prev = document.createElement("button");
            prev.className = "dotpm-dm-nav";
            prev.dataset.role = "prev";
            prev.setAttribute("aria-label", "上个月");
            const month = document.createElement("div");
            month.className = "dotpm-dm-month";
            const next = document.createElement("button");
            next.className = "dotpm-dm-nav";
            next.dataset.role = "next";
            next.setAttribute("aria-label", "下个月");
            try {
                obsidian.setIcon(prev, "chevron-left");
                obsidian.setIcon(next, "chevron-right");
            } catch (e) {
                prev.textContent = "‹";
                next.textContent = "›";
            }
            head.append(prev, month, next);
            cal.appendChild(head);

            const tgtRow = document.createElement("div");
            tgtRow.className = "dotpm-dm-seg";
            if (context) tgtRow.classList.add("dotpm-dm-seg-reserved");
            const bStart = document.createElement("button");
            bStart.className = "dotpm-dm-seg-btn";
            bStart.textContent = "开始";
            bStart.dataset.role = "target-start";
            const thumb = document.createElement("div");
            thumb.className = "dotpm-dm-seg-thumb";
            const bEnd = document.createElement("button");
            bEnd.className = "dotpm-dm-seg-btn";
            bEnd.dataset.role = "target-end";
            const endLabel = document.createElement("span");
            endLabel.textContent = "结束";
            bEnd.appendChild(endLabel);
            const clearButton = (role, label) => {
                const button = document.createElement("button");
                button.className = "dotpm-dm-clear";
                button.dataset.role = role;
                button.setAttribute("aria-label", label);
                button.textContent = "×";
                return button;
            };
            const clearStart = clearButton("clear-start", "只保留截止日期");
            const clearEnd = clearButton("clear-end", "只保留开始日期");
            tgtRow.append(thumb, bStart, clearStart, bEnd, clearEnd);
            cal.appendChild(tgtRow);

            const week = document.createElement("div");
            week.className = "dotpm-dm-week";
            ["日", "一", "二", "三", "四", "五", "六"].forEach((w) => {
                const c = document.createElement("span");
                c.textContent = w;
                week.appendChild(c);
            });
            cal.appendChild(week);

            const grid = document.createElement("div");
            grid.className = "dotpm-dm-grid";
            cal.appendChild(grid);

            const timeRow = document.createElement("div");
            timeRow.className = "dotpm-dm-timerow";
            const timeChk = document.createElement("input");
            timeChk.type = "checkbox";
            timeChk.dataset.role = "timemode";
            const timeLb = document.createElement("label");
            timeLb.className = "dotpm-dm-check";
            timeLb.append(timeChk, document.createTextNode("带时间"));
            const timeInp = document.createElement("div");
            timeInp.className = "dotpm-dm-clock";
            timeInp.setAttribute("aria-label", "当前时刻（24 小时制）");
            const timeParts = {};
            for (const [part, label] of [["hour", "小时"], ["minute", "分钟"]]) {
                if (part === "minute") timeInp.append(document.createTextNode(":"));
                const input = document.createElement("input");
                input.type = "text";
                input.inputMode = "numeric";
                input.maxLength = 2;
                input.dataset.role = part;
                input.setAttribute("aria-label", label);
                input.title = "可输入或用上下键调整" + label;
                timeInp.append(input);
                timeParts[part] = { input };
            }
            timeRow.append(timeLb, timeInp);
            gTime.append(timeRow);
            const durations = document.createElement("div");
            durations.className = "dotpm-dm-durations";
            durations.setAttribute("role", "group");
            durations.setAttribute("aria-label", "计划持续时长");
            for (const [minutes, label] of [[0, "无"], [15, "15m"], [30, "30m"], [45, "45m"], [60, "1h"]]) {
                const button = document.createElement("button");
                button.type = "button";
                button.dataset.duration = String(minutes);
                button.textContent = label;
                button.onclick = () => {
                    if (button.disabled) return;
                    cleared = false;
                    durationLock = minutes;
                    st.end = minutes ? new Date(st.start.getTime() + minutes * 60000) : null;
                    st.target = "start";
                    st.vy = st.start.getFullYear();
                    st.vm = st.start.getMonth();
                    render();
                };
                durations.append(button);
            }

            const dial = document.createElement("div");
            dial.className = "dotpm-dm-dial";
            dial.dataset.role = "dial";
            const ns = "http://www.w3.org/2000/svg";
            const svg = (tag, attrs = {}) => {
                const node = document.createElementNS(ns, tag);
                for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
                return node;
            };
            const face = svg("svg", { viewBox: "0 0 240 240", "aria-hidden": "true" });
            const point = (value, radius, count = 60) => {
                const angle = value / count * Math.PI * 2 - Math.PI / 2;
                return { x: 120 + radius * Math.cos(angle), y: 120 + radius * Math.sin(angle) };
            };
            face.append(svg("circle", { cx: 120, cy: 120, r: 105, class: "dotpm-dm-dial-orbit" }),
                svg("circle", { cx: 120, cy: 120, r: 68, class: "dotpm-dm-dial-orbit inner" }));
            for (let i = 0; i < 60; i++) {
                const a = point(i, 114), b = point(i, i % 5 === 0 ? 109 : 112);
                face.append(svg("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: "dotpm-dm-dial-tick" }));
            }
            const hourRay = svg("line", { x1: 120, y1: 120, class: "dotpm-dm-hour-ray" });
            const minuteRay = svg("line", { x1: 120, y1: 120, class: "dotpm-dm-minute-ray" });
            const minuteDot = svg("circle", { r: 2.5, class: "dotpm-dm-minute-dot" });
            face.append(hourRay, minuteRay, minuteDot);
            dial.append(face);
            const dialButtons = [];
            for (const [part, radius, count] of [["minute", 99, 60], ["hour", 65, 12]]) {
                for (let i = 0; i < count; i += part === "minute" ? 5 : 1) {
                    const pos = point(i, radius, count);
                    const button = document.createElement("button");
                    button.type = "button";
                    button.className = "dotpm-dm-dial-number " + part;
                    button.dataset.part = part;
                    button.dataset.value = String(i);
                    button.style.left = pos.x / 240 * 100 + "%";
                    button.style.top = pos.y / 240 * 100 + "%";
                    button.textContent = part === "hour" ? String(i || 12) : pad(i);
                    button.setAttribute("aria-label", part === "hour" ? (i || 12) + "点" : pad(i) + "分");
                    dialButtons.push(button);
                    dial.append(button);
                }
            }
            const period = document.createElement("button");
            period.type = "button";
            period.className = "dotpm-dm-period";
            period.dataset.role = "period";
            period.title = "切换上午 / 下午";
            dial.append(period);
            dial.title = "内圈选小时，外圈选分钟";
            const timeContent = document.createElement("div");
            timeContent.className = "dotpm-dm-time-content";
            timeContent.append(gTime, dial, durations);
            side.append(timeContent);

            const chips = document.createElement("div");
            chips.className = "dotpm-dm-chips dotpm-dm-chips--4";
            for (const [label, role] of [["−1周", "minusweek"], ["−1天", "minus1"], ["+1天", "plus1"], ["+1周", "plusweek"]]) {
                const button = document.createElement("button");
                button.type = "button";
                button.className = "dotpm-dm-chip";
                button.dataset.role = role;
                button.textContent = label;
                chips.append(button);
            }
            gDates.append(chips);
            cal.append(gDates);

            const bottom = document.createElement("div");
            bottom.className = "dotpm-dm-bottom";
            const resultRow = document.createElement("div");
            resultRow.className = "dotpm-dm-result-row";
            const resultEntry = document.createElement("div");
            resultEntry.className = "dotpm-dm-result-entry";
            const resultOutput = document.createElement("div");
            resultOutput.className = "dotpm-dm-result-output";
            resultOutput.dataset.role = "resolved-date";
            resultOutput.setAttribute("aria-live", "polite");
            const prevBox = document.createElement("input");
            prevBox.type = "text";
            prevBox.autocomplete = "off";
            prevBox.spellcheck = false;
            prevBox.className = "dotpm-dm-preview";
            prevBox.setAttribute("aria-label", "用自然语言输入日期时间");
            prevBox.placeholder = "输入日期或时间，如：明天下午3点";
            prevBox.title = "支持自然日期、简写日期、起止时间及持续时长";
            prevBox.dataset.role = "preview";
            const copy = document.createElement("button");
            copy.type = "button";
            copy.className = "dotpm-dm-icon-button";
            copy.dataset.role = "copy-date";
            copy.setAttribute("aria-label", "复制日期时间");
            copy.title = "复制日期时间";
            obsidian.setIcon(copy, "copy");
            const clear = document.createElement("button");
            clear.type = "button";
            clear.className = "dotpm-dm-icon-button";
            clear.dataset.role = "clear-date";
            clear.setAttribute("aria-label", "清空日期（确定后生效）");
            clear.title = this.detected?.taskDate ? "状态时间参与计时，不支持单独清空" : "清空日期（确定后生效）";
            clear.disabled = !!this.detected?.taskDate;
            obsidian.setIcon(clear, "eraser");
            const foot = document.createElement("div");
            foot.className = "dotpm-dm-footer";
            const cancel = document.createElement("button");
            cancel.className = "dotpm-dm-ghost";
            cancel.textContent = "取消";
            const ok = document.createElement("button");
            ok.className = "dotpm-dm-primary";
            ok.textContent = "确定";
            ok.dataset.role = "ok";
            foot.append(cancel, ok);
            resultEntry.append(prevBox, copy, clear);
            resultRow.append(resultEntry, resultOutput);
            el.insertBefore(resultRow, bodyEl);
            const toggleTime = document.createElement("button");
            toggleTime.type = "button";
            toggleTime.className = "dotpm-dm-ghost dotpm-dm-toggle-time";
            toggleTime.dataset.role = "toggle-time";
            toggleTime.setAttribute("aria-controls", side.id);
            toggleTime.setAttribute("aria-expanded", "false");
            const toggleIcon = document.createElement("span");
            obsidian.setIcon(toggleIcon, "clock");
            toggleIcon.setAttribute("aria-hidden", "true");
            const toggleLabel = document.createTextNode("设置时间");
            toggleTime.append(toggleIcon, toggleLabel);
            toggleTime.onclick = () => {
                const expanded = side.inert;
                if (!expanded && side.contains(document.activeElement)) toggleTime.focus();
                side.inert = !expanded;
                el.classList.add("has-time-motion");
                el.classList.toggle("is-time-open", expanded);
                toggleTime.setAttribute("aria-expanded", String(expanded));
                toggleLabel.textContent = expanded ? "收起时间" : "设置时间";
                const popupChrome = el.offsetWidth - bodyEl.offsetWidth;
                this.place(dateColumn.offsetWidth + (expanded ? timeContent.offsetWidth : 0) + popupChrome);
            };
            bottom.append(toggleTime, foot);
            el.append(bottom);

            const targetDate = () => (st.target === "end" ? st.end : st.start);
            const setTargetDate = (d) => {
                cleared = false;
                if (st.target === "end") { st.end = d; durationLock = 0; }
                else {
                    st.start = d;
                    if (durationLock) st.end = new Date(d.getTime() + durationLock * 60000);
                }
            };
            const token = () => {
                const s = st.start;
                const e = st.end;
                const withTime = st.withTime;
                if (st.deadlineOnly) return "~" + (withTime ? fmt(e) : dstr(e));
                if (!s) return "";
                if (withTime) return e ? `${fmt(s)}~${sameDay(s, e) ? hm(e) : fmt(e)}` : fmt(s);
                return e ? `${dstr(s)}~${dstr(e)}` : dstr(s);
            };
            const previewToken = () => cleared ? "未设置日期" : st.deadlineOnly ? "截止 " + token().slice(1) : token();

            let editingResult = false;
            const friendlyInput = () => {
                const day = date => date.getFullYear() === inputAnchor.getFullYear()
                    ? `${date.getMonth() + 1}/${date.getDate()}` : dstr(date);
                const value = date => day(date) + (st.withTime ? " " + hm(date) : "");
                if (cleared) return "";
                if (st.deadlineOnly) return "截止 " + value(st.end);
                return value(st.start) + (st.end ? " ~ " + (st.withTime && sameDay(st.start, st.end) ? hm(st.end) : value(st.end)) : "");
            };
            const parseResultInput = () => {
                const invalid = message => {
                    prevBox.setAttribute("aria-invalid", "true");
                    prevBox.title = message;
                    resultOutput.textContent = message;
                    resultOutput.classList.add("is-invalid");
                    return false;
                };
                const value = prevBox.value.trim();
                if (!value) {
                    if (this.detected?.taskDate) return invalid("状态时间参与计时，不能清空");
                    cleared = true; durationLock = 0;
                    prevBox.removeAttribute("aria-invalid");
                    return true;
                }
                const result = parsePickerInput(value, inputAnchor, inputBaseDate);
                if (result.error) return invalid(result.error);
                if (this.detected?.valueOnly && (result.deadline || result.end)) return invalid("状态记录只接受单个时间点");
                if (this.detected?.taskDate && !result.withTime) return invalid("状态记录需要包含时刻");
                cleared = false; durationLock = result.duration;
                st.start = result.start;
                st.end = result.deadline ? new Date(result.start) : result.end;
                st.deadlineOnly = result.deadline;
                st.withTime = result.withTime;
                if (result.deadline) st.target = "end";
                else if (!st.end) st.target = "start";
                const active = targetDate() || st.start;
                st.vy = active.getFullYear(); st.vm = active.getMonth();
                prevBox.removeAttribute("aria-invalid");
                prevBox.title = "自然输入会转换为下方标准格式，确定后写入";
                return true;
            };
            prevBox.addEventListener("input", event => {
                if (event.isComposing) return;
                editingResult = true;
                try { if (parseResultInput()) render(); }
                finally { editingResult = false; }
            });
            prevBox.addEventListener("compositionend", () => {
                editingResult = true;
                try { if (parseResultInput()) render(); }
                finally { editingResult = false; }
            });
            prevBox.addEventListener("blur", () => {
                editingResult = true;
                try { if (parseResultInput()) refreshTime(); }
                finally { editingResult = false; }
            });

            const render = () => {
                // 正在拖拽时用拖拽区间，否则用已选区间
                let rangeA = cleared || st.deadlineOnly ? null : dayKey(st.start);
                let rangeB = !cleared && st.end ? dayKey(st.end) : null;
                if (dragging && dragFrom && dragTo) {
                    const forward = dragFrom.getTime() <= dragTo.getTime();
                    rangeA = st.deadlineOnly ? null : dayKey(forward ? dragFrom : dragTo);
                    rangeB = dayKey(st.deadlineOnly || forward ? dragTo : dragFrom);
                }
                month.textContent = `${st.vy}年${st.vm + 1}月`;
                bStart.classList.toggle("is-on", st.target === "start");
                bEnd.classList.toggle("is-on", st.target === "end");
                endLabel.textContent = st.deadlineOnly ? "截止" : "结束";
                const pending = st.target === "end" && !st.end;
                bEnd.classList.toggle("is-pending", pending);
                thumb.classList.toggle("is-pending", pending);
                thumb.style.transform = st.target === "end" ? "translateX(calc(100% + 2px))" : "translateX(0)";
                tgtRow.hidden = !!this.detected?.valueOnly;
                clear.disabled = !!this.detected?.taskDate;
                clear.title = clear.disabled ? "状态时间参与计时，不支持单独清空" : "清空日期（确定后生效）";
                clearStart.hidden = !!this.detected?.valueOnly || st.deadlineOnly;
                clearEnd.hidden = !!this.detected?.valueOnly || !st.end;
                bEnd.hidden = !!this.detected?.valueOnly;
                thumb.hidden = !!this.detected?.valueOnly;
                timeChk.disabled = !!this.detected?.taskDate;
                bStart.title = "点日期改开始日期";
                bEnd.title = st.end ? "点日期改结束日期" : "选一个结束日期（做时间段）";
                const sel = targetDate();
                const today = new Date();
                const first = new Date(st.vy, st.vm, 1);
                const startIdx = first.getDay();
                const base = new Date(st.vy, st.vm, 1 - startIdx);
                grid.textContent = "";
                const daysInMonth = new Date(st.vy, st.vm + 1, 0).getDate();
                const rows = context ? 6 : Math.ceil((startIdx + daysInMonth) / 7);
                for (let i = 0; i < rows * 7; i++) {
                    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
                    const b = document.createElement("button");
                    b.className = "dotpm-dm-day";
                    b.textContent = String(d.getDate());
                    b.dataset.role = "day";
                    b.dataset.day = dayKey(d);
                    b.tabIndex = -1;
                    const key = dayKey(d);
                    const sK = rangeA;
                    const eK = rangeB;
                    if (d.getMonth() !== st.vm) b.classList.add("is-outside");
                    if (eK) {
                        if (key === sK) b.classList.add("is-start");
                        else if (key === eK) b.classList.add("is-end");
                        else if (sK && key > sK && key < eK) b.classList.add("is-range");
                        else if (key === dayKey(today)) b.classList.add("is-today");
                    } else {
                        if (!cleared && sel && key === dayKey(sel)) b.classList.add("is-selected");
                        else if (key === dayKey(today)) b.classList.add("is-today");
                    }
                    b.addEventListener("mousedown", (e) => {
                        e.preventDefault();
                        dragging = true;
                        dragFrom = d;
                        dragTo = d;
                    });
                    b.addEventListener("mouseenter", () => {
                        if (!dragging) return;
                        if (dragTo && dayKey(dragTo) === dayKey(d)) return;
                        dragTo = d;
                        render();
                    });
                    grid.appendChild(b);
                }
                refreshTime();
            };

            const refreshTime = (preserveInput = false) => {
                const date = targetDate() || st.start;
                const disabled = !st.withTime || cleared;
                timeChk.checked = st.withTime;
                const durationDisabled = disabled || !!this.detected?.valueOnly || st.deadlineOnly;
                const minutes = st.end && !st.deadlineOnly ? (st.end.getTime() - st.start.getTime()) / 60000 : 0;
                for (const button of durations.children) {
                    button.disabled = durationDisabled;
                    button.title = this.detected?.valueOnly ? "状态记录为单个时间点，不设置时长" : st.deadlineOnly ? "仅截止日期不设置时长" : Number(button.dataset.duration) ? "设置计划时长为 " + button.dataset.duration + " 分钟" : "不设置计划结束时间";
                    button.setAttribute("aria-pressed", String(!durationDisabled && Number(button.dataset.duration) === minutes));
                }
                for (const [part, { input }] of Object.entries(timeParts)) {
                    if (!preserveInput) {
                        input.value = pad(part === "hour" ? date.getHours() : date.getMinutes());
                        input.removeAttribute("aria-invalid");
                    }
                    input.disabled = disabled;
                }
                dial.classList.toggle("is-disabled", disabled);
                dial.setAttribute("aria-disabled", String(disabled));
                for (const button of dialButtons) {
                    button.disabled = disabled;
                    const current = button.dataset.part === "hour" ? date.getHours() % 12 : date.getMinutes();
                    button.setAttribute("aria-pressed", String(Number(button.dataset.value) === current));
                }
                period.textContent = date.getHours() < 12 ? "AM" : "PM";
                period.setAttribute("aria-label", date.getHours() < 12 ? "上午，点击切换下午" : "下午，点击切换上午");
                period.disabled = disabled;
                const hp = point(date.getHours() % 12, 65, 12), mp = point(date.getMinutes(), 99);
                hourRay.setAttribute("x2", hp.x); hourRay.setAttribute("y2", hp.y);
                minuteRay.setAttribute("x2", mp.x); minuteRay.setAttribute("y2", mp.y);
                minuteDot.setAttribute("cx", mp.x);
                minuteDot.setAttribute("cy", mp.y);
                if (!editingResult) {
                    inputBaseDate = new Date(st.start);
                    prevBox.value = friendlyInput();
                    prevBox.removeAttribute("aria-invalid");
                }
                resultOutput.textContent = cleared ? "未设置日期" : "标准格式  " + token();
                resultOutput.classList.remove("is-invalid");
                copy.disabled = cleared;
            };
            const updateClock = (date) => {
                const previousDay = dayKey(targetDate() || st.start);
                setTargetDate(date);
                if (dayKey(date) !== previousDay) {
                    st.vy = date.getFullYear(); st.vm = date.getMonth(); render();
                } else refreshTime();
            };
            const setClockPart = (part, value) => {
                const date = new Date(targetDate() || st.start);
                if (part === "hour") date.setHours((date.getHours() >= 12 ? 12 : 0) + value);
                else date.setMinutes(value);
                updateClock(date);
            };
            period.onclick = () => {
                const date = new Date(targetDate() || st.start);
                date.setHours((date.getHours() + 12) % 24);
                updateClock(date);
            };
            let clockDrag = null;
            const dialPosition = event => {
                const rect = dial.getBoundingClientRect();
                const x = (event.clientX - rect.left) * 240 / rect.width - 120;
                const y = (event.clientY - rect.top) * 240 / rect.height - 120;
                return { radius: Math.hypot(x, y), minute: (Math.round((Math.atan2(y, x) + Math.PI / 2) / (Math.PI * 2) * 60) + 60) % 60 };
            };
            dial.addEventListener("pointerdown", event => {
                if (!st.withTime || cleared || event.button !== 0 || event.target.closest(".dotpm-dm-period")) return;
                const pos = dialPosition(event);
                if (pos.radius < 34 || pos.radius > 120) return;
                event.preventDefault();
                const part = event.target.closest("[data-part]")?.dataset.part || (pos.radius >= 83 ? "minute" : "hour");
                clockDrag = { id: event.pointerId, part, last: pos.minute };
                dial.setPointerCapture(event.pointerId);
                setClockPart(part, part === "hour" ? Math.round(pos.minute / 5) % 12 : pos.minute);
            });
            dial.addEventListener("pointermove", event => {
                if (!clockDrag || clockDrag.id !== event.pointerId) return;
                const pos = dialPosition(event);
                if (clockDrag.part === "hour") setClockPart("hour", Math.round(pos.minute / 5) % 12);
                else {
                    let delta = pos.minute - clockDrag.last;
                    if (delta > 30) delta -= 60;
                    if (delta < -30) delta += 60;
                    const date = new Date(targetDate() || st.start);
                    date.setMinutes(date.getMinutes() + delta);
                    updateClock(date);
                }
                clockDrag.last = pos.minute;
            });
            const finishClockDrag = event => {
                if (clockDrag?.id !== event.pointerId) return;
                clockDrag = null;
                if (dial.hasPointerCapture(event.pointerId)) dial.releasePointerCapture(event.pointerId);
            };
            dial.addEventListener("pointerup", finishClockDrag);
            dial.addEventListener("pointercancel", finishClockDrag);
            dial.addEventListener("lostpointercapture", () => { clockDrag = null; });
            for (const button of dialButtons) {
                button.onclick = event => {
                    // Pointer gestures already set the value on pointerdown; keyboard clicks have detail 0.
                    if (event.detail === 0) setClockPart(button.dataset.part, Number(button.dataset.value));
                };
            }
            for (const [part, { input }] of Object.entries(timeParts)) {
                const step = delta => {
                    const date = new Date(targetDate() || st.start);
                    if (part === "hour") date.setHours(date.getHours() + delta);
                    else date.setMinutes(date.getMinutes() + delta);
                    updateClock(date);
                };
                input.addEventListener("wheel", event => {
                    if (!st.withTime || cleared) return;
                    event.preventDefault();
                    if (event.deltaY) step(-Math.sign(event.deltaY));
                }, { passive: false });
                input.addEventListener("keydown", event => {
                    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                    event.preventDefault(); event.stopPropagation();
                    step(event.key === "ArrowUp" ? 1 : -1);
                });
                input.addEventListener("focus", () => input.select());
            }
            copy.onclick = async () => {
                try {
                    if (!parseResultInput()) { new Notice(prevBox.title); return; }
                    await navigator.clipboard.writeText(token()); new Notice("已复制标准日期时间");
                }
                catch (error) { new Notice("复制失败，请重试"); }
            };
            clear.onclick = () => { cleared = true; durationLock = 0; render(); };

            const calendarDay = () => {
                const selected = targetDate() || st.start;
                return (selected && grid.querySelector('[data-day="' + dayKey(selected) + '"]')) ||
                    grid.querySelector(".dotpm-dm-day:not(.is-outside)");
            };

            this.navigate = (event) => {
                if (event.altKey || event.ctrlKey || event.metaKey) return false;
                const active = document.activeElement;
                if (event.key === "Tab") {
                    const day = calendarDay();
                    const controls = [...el.querySelectorAll("button:not(:disabled), input:not(:disabled), select:not(:disabled)")]
                        .filter(control => control.getClientRects().length && (!grid.contains(control) || control === day));
                    const index = controls.indexOf(active);
                    const step = event.shiftKey ? -1 : 1;
                    const nextControl = index < 0
                        ? (event.shiftKey ? controls.at(-1) : day || controls[0])
                        : controls[(index + step + controls.length) % controls.length];
                    nextControl?.focus();
                    return true;
                }
                const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
                if (!offset || event.shiftKey || (el.contains(active) && !grid.contains(active))) return false;
                const date = new Date(targetDate() || st.start || new Date());
                date.setDate(date.getDate() + offset);
                setTargetDate(date);
                st.vy = date.getFullYear();
                st.vm = date.getMonth();
                render();
                calendarDay()?.focus();
                return true;
            };

            prev.onclick = () => { st.vm--; if (st.vm < 0) { st.vm = 11; st.vy--; } render(); };
            next.onclick = () => { st.vm++; if (st.vm > 11) { st.vm = 0; st.vy++; } render(); };

            bStart.onclick = () => {
                st.deadlineOnly = false;
                st.target = "start";
                st.vy = st.start.getFullYear();
                st.vm = st.start.getMonth();
                render();
            };
            bEnd.onclick = () => {
                st.target = "end";
                render();
            };
            clearStart.onclick = () => {
                durationLock = 0;
                st.deadlineOnly = true;
                st.end ??= new Date(st.start.getTime());
                st.target = "end";
                st.vy = st.end.getFullYear();
                st.vm = st.end.getMonth();
                render();
            };
            clearEnd.onclick = () => {
                if (st.deadlineOnly) st.start = st.end;
                st.end = null;
                bStart.click();
            };

            timeChk.onchange = () => { cleared = false; st.withTime = timeChk.checked; savePrefs({ withTime: st.withTime }); render(); };
            const applyTimeInput = () => {
                if (!st.withTime || cleared) return true;
                let valid = true;
                for (const [part, { input }] of Object.entries(timeParts)) {
                    const value = input.value.trim();
                    const okay = /^\d{1,2}$/.test(value) && Number(value) <= (part === "hour" ? 23 : 59);
                    if (!okay) input.setAttribute("aria-invalid", "true");
                    else input.removeAttribute("aria-invalid");
                    valid = valid && okay;
                }
                if (!valid) return false;
                const t = targetDate() || st.start;
                setTargetDate(new Date(t.getFullYear(), t.getMonth(), t.getDate(), +timeParts.hour.input.value, +timeParts.minute.input.value, 0, 0));
                refreshTime(true);
                return true;
            };
            for (const { input } of Object.values(timeParts)) input.addEventListener("input", applyTimeInput);

            const shift = (days, months) => {
                const t = targetDate() || st.start || new Date();
                const nd = new Date(t.getTime());
                if (days) nd.setDate(nd.getDate() + days);
                if (months) nd.setMonth(nd.getMonth() + months);
                setTargetDate(nd);
                st.vy = nd.getFullYear();
                st.vm = nd.getMonth();
                render();
            };
            chips.querySelector('[data-role=minusweek]').onclick = () => shift(-7, 0);
            chips.querySelector('[data-role=plusweek]').onclick = () => shift(7, 0);
            chips.querySelector('[data-role=minus1]').onclick = () => shift(-1, 0);
            chips.querySelector('[data-role=plus1]').onclick = () => shift(1, 0);

            // 点某个日期：写入当前目标字段（开始 / 结束），继承已有时间
            const applyDay = (d) => {
                const t = targetDate() || st.start;
                const hh = st.withTime && t ? t.getHours() : 9;
                const mm = st.withTime && t ? t.getMinutes() : 0;
                const nd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, 0, 0);
                setTargetDate(nd);
                st.vy = d.getFullYear();
                st.vm = d.getMonth();
                render();
            };

            const commitDrag = () => {
                if (!dragging) return;
                dragging = false;
                if (!dragFrom || !dragTo) { dragFrom = dragTo = null; render(); return; }
                const moved = dayKey(dragFrom) !== dayKey(dragTo);
                if (!moved || st.deadlineOnly) {
                    // 原地按下松开 = 普通单击（不会产生 click 事件，因为拖动时 DOM 被重建过）
                    const d0 = st.deadlineOnly ? dragTo : dragFrom;
                    dragFrom = dragTo = null;
                    applyDay(d0);
                    return;
                }
                let a = dragFrom;
                let c = dragTo;
                suppressClick = true;
                if (dayKey(a) > dayKey(c)) { const t = a; a = c; c = t; }
                const base = st.start || new Date();
                const hh = st.withTime ? base.getHours() : 9;
                const mm = st.withTime ? base.getMinutes() : 0;
                const s = new Date(a.getFullYear(), a.getMonth(), a.getDate(), hh, mm, 0, 0);
                const e = new Date(c.getFullYear(), c.getMonth(), c.getDate(), hh, mm, 0, 0);
                st.start = s;
                st.end = e;
                st.target = st.end ? "end" : "start";
                dragFrom = dragTo = null;
                st.vy = s.getFullYear();
                st.vm = s.getMonth();
                render();
            };
            document.addEventListener("mouseup", commitDrag, true);
            this.offUp = () => document.removeEventListener("mouseup", commitDrag, true);

            const confirm = () => {
                if (!parseResultInput()) {
                    new Notice(prevBox.title);
                    prevBox.focus();
                    return;
                }
                if (cleared) {
                    if (this.context && this.target.text() !== this.context.full) { new Notice("文本已更新，请重新打开日期选择器。"); return; }
                    const range = this.replaceAt || this.detected;
                    if (range && !range.taskDate && this.target.insert("", range.start, range.end) === false) return;
                    this.close();
                    return;
                }
                if (!applyTimeInput()) {
                    new Notice("请输入有效的时刻，例如 15:26。");
                    (timeInp.querySelector('[aria-invalid="true"]') || timeParts.hour.input).focus();
                    return;
                }
                // 不再强制取整：面板显示什么就插入什么（需要取整请点「取整」）
                if (!st.deadlineOnly && st.end && st.end.getTime() < st.start.getTime()) { new Notice("结束早于开始"); return; }
                const rng = this.replaceAt || this.detected;
                if (insertText(token(), rng)) this.close();
            };
            ok.onclick = confirm;
            cancel.onclick = () => this.close();


            // 点击面板内部不抢焦点：只有时间输入框和步长下拉需要真正获得焦点
            el.addEventListener("mousedown", (ev) => {
                const t = ev.target;
                if (t?.closest?.("select, .dotpm-dm-clock input, .dotpm-dm-result-row input, .dotpm-dm-dial")) return;
                ev.preventDefault();
                if (this.target) {
                    const self = this;
                    const keep = () => {
                        if (!self.el || self.el.contains(document.activeElement)) return;
                        try { self.target.focus(); } catch (e) {}
                        if (self.target.kind === "ta" && self.target.el && self.target.el.isConnected && caret) {
                            try { self.target.el.setSelectionRange(caret.end, caret.end); } catch (e) {}
                        }
                    };
                    keep();
                    setTimeout(keep, 0);
                    setTimeout(keep, 80);
                }
            }, true);

            render();
            if (this.fixed) el.style.position = "fixed";
            this.host.appendChild(el);
            this.place();

            this.onDown = (ev) => { if (this.el && !this.el.contains(ev.target)) this.close(); };
            setTimeout(() => {
                if (!disposed && this.el) document.addEventListener("mousedown", this.onDown, true);
            }, 0);
        }

        place(targetWidth) {
            const el = this.el;
            const host = this.host;
            if (this.fixed) el.style.position = "fixed";
            const hr = this.fixed
                ? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight, width: window.innerWidth, height: window.innerHeight }
                : host.getBoundingClientRect();
            let anchor;
            if (this.anchorEl) {
                const r = this.anchorEl.getBoundingClientRect();
                anchor = { left: r.left - hr.left, top: r.top - hr.top, bottom: r.bottom - hr.top };
            } else {
                anchor = this.target ? this.target.point() : caretPoint(descBox(), host);
                if (!this.fixed) anchor = { left: anchor.left - hr.left, top: anchor.top - hr.top, bottom: anchor.bottom - hr.top };
            }
            const bw = targetWidth ?? el.offsetWidth, bh = el.offsetHeight;

            if (this.fixed) {
                // 编辑器场景：贴着光标放置，并按视口收边
                let left = anchor.left;
                let top = anchor.bottom + 6;
                if (left + bw > window.innerWidth - 8) left = window.innerWidth - bw - 8;
                if (top + bh > window.innerHeight - 8) top = anchor.top - bh - 6;
                left = Math.max(8, left);
                top = Math.max(8, top);
                el.style.left = left + "px";
                el.style.top = top + "px";
                return;
            }

            // 任务弹窗场景：同样紧跟光标，活动范围限制在「宿主 ∩ 视口」内
            const visRight = Math.min(hr.right, window.innerWidth) - hr.left;
            const visBottom = Math.min(hr.bottom, window.innerHeight) - hr.top;
            const visLeft = Math.max(0, -hr.left);
            const visTop = Math.max(0, -hr.top);

            let left = anchor.left;
            let top = anchor.bottom + 6;

            // 右侧越界 → 左移收边
            if (left + bw > visRight - 10) left = visRight - bw - 10;
            if (left < visLeft + 10) left = visLeft + 10;
            // 下方空间不足 → 翻到光标上方
            if (top + bh > visBottom - 10) top = anchor.top - bh - 6;
            if (top < visTop + 10) top = Math.min(visTop + 10, Math.max(visTop + 10, visBottom - bh - 10));

            el.style.left = left + "px";
            el.style.top = top + "px";
        }

        close() {
            if (currentPopover === this) currentPopover = null;
            if (!this.el) return;
            try { this.el.remove(); } catch (e) {}
            this.el = null;
            if (this.onDown) document.removeEventListener("mousedown", this.onDown, true);
            if (this.offUp) this.offUp();
            const tgt = this.target || curTarget;
            const restore = () => {
                if (disposed || currentPopover || !tgt) return;
                try { tgt.focus(); } catch (e) {}
                if (tgt.kind === "ta" && tgt.el && tgt.el.isConnected) {
                    try {
                        const p = caret ? caret.end : tgt.el.value.length;
                        tgt.el.setSelectionRange(p, p);
                    } catch (e) {}
                }
            };
            setTimeout(restore, 0);
            setTimeout(restore, 60);
            setTimeout(restore, 180);
        }
    }

    window.__dotpmDateUI_keydown = (e) => {
        // The picker keeps focus in the editor, so handle its keys before the editor does.
        const picker = currentPopover?.el;
        const confirm = e.key === "Enter" && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
        if (picker?.isConnected && !e.isComposing) {
            const navigated = currentPopover.navigate?.(e);
            if (navigated || confirm || e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                if (confirm) {
                    const button = e.target?.closest?.("button");
                    if (picker.contains(button) && !button.matches(".dotpm-dm-day")) button.click();
                    else picker.querySelector(".dotpm-dm-primary")?.click();
                } else if (e.key === "Escape") currentPopover.close();
                return;
            }
        }

        const editor = editorOf();
        const inOrdinaryEditor = editor?.cm.contentDOM.contains(e.target) &&
            !editor.cm.dom.closest(".dotpm-live-native");
        // The embedded editor and textarea have their own @ handlers.
        if (e.key !== "@" || e.isComposing || e.altKey || e.ctrlKey || e.metaKey || !inOrdinaryEditor) return;
        setTimeout(() => {
            if (popover() || !editor.cm.dom.isConnected || !editor.cm.hasFocus) return;
            const offset = editor.posToOffset(editor.getCursor());
            if (editor.getValue().charAt(offset - 1) === "@") {
                openPicker({ start: offset - 1, end: offset }, null, true, editor);
            }
        }, 0);
    };
    document.addEventListener("keydown", window.__dotpmDateUI_keydown, true);

    const openDateAtPointer = event => {
        const badge = event.target?.closest?.(".pm-time:not(.pm-time--running)");
        if (!badge) return;
        const view = [...plugin.inlineTimeViews].find(candidate => candidate.contentDOM.contains(badge));
        if (!view || view.state.readOnly) return;
        const binding = [...(plugin.live2Bindings?.values() || [])].find(candidate => candidate.view === view);
        const editor = binding?.native.editor || app.workspace.getLeavesOfType("markdown")
            .map(leaf => leaf.view.editor).find(candidate => candidate?.cm === view);
        if (!editor) return;

        const compact = badge.classList.contains("dotpm-time-compact");
        const position = compact ? view.posAtDOM(badge, 0) :
            view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.posAtDOM(badge, 0);
        const line = view.state.doc.lineAt(position);
        const offset = position - line.from;
        const detected = detectAtCaret(line.text, offset);
        if (!detected) return;
        if (detected.endValue) {
            const divider = line.text.indexOf("~", detected.start);
            if (divider >= detected.start && divider < detected.end && offset > divider) detected.target = "end";
        }
        detected.start += line.from;
        detected.end += line.from;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (compact) hideCompactTimeCard(badge, true);
        openPicker(null, badge, true, editor, detected);
    };
    document.addEventListener("contextmenu", openDateAtPointer, true);

    if (window.__dotpmDateUI_input) document.removeEventListener("input", window.__dotpmDateUI_input, true);
    window.__dotpmDateUI_input = (ev) => {
        const el = ev.target;
        if (!el || el.tagName !== "TEXTAREA" || !el.classList.contains("pm-modal-description")) return;
        if (popover()) return;
        const pos = el.selectionStart ?? 0;
        if (pos <= 0) return;
        if (el.value.charAt(pos - 1) !== "@") return;
        caret = { start: pos, end: pos };
        const at = pos - 1;
        setTimeout(() => openPicker({ start: at, end: at + 1 }, null), 0);
    };
    document.addEventListener("input", window.__dotpmDateUI_input, true);

    const dispose = () => {
        if (disposed) return;
        disposed = true;
        currentPopover?.close();
        document.removeEventListener("selectionchange", onSelectionChange);
        document.removeEventListener("keydown", window.__dotpmDateUI_keydown, true);
        document.removeEventListener("contextmenu", openDateAtPointer, true);
        document.removeEventListener("input", window.__dotpmDateUI_input, true);
        document.getElementById("dotpm-dm-style")?.remove();
        for (const key of ["__dotpmDateUI", "__dotpmDateUI_keydown",
            "__dotpmDateUI_input", "__dotpmOpenPicker", "__dotpmOpenDatePicker", "__dotpmDateUIDispose"]) {
            delete window[key];
        }
    };
    window.__dotpmDateUIDispose = dispose;
    return dispose;
}
