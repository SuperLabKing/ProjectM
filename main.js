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
const { Plugin, PluginSettingTab, Setting, MarkdownRenderer, Menu, Notice, Scope, getFrontMatterInfo } = require("obsidian");

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
  const states = new Set(children.map(child => child.task.current));
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

  installDotpmProgressWrite() {
    const store = this.app.plugins.plugins["project-manager"]?.store;
    if (!store || this.progressWriteStore === store || typeof store.saveTaskFile !== "function") return;
    this.progressWriteStore = store;
    const saveTaskFile = store.saveTaskFile;
    const { vault, metadataCache } = this.app;
    const plugin = this;
    let active = true;
    function saveWithChecklistProgress(task, project, parent, path, kind) {
      if (active && plugin.settings.enabled && kind !== "fm" &&
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
            await vault.process(file, current => disposed ? current : updateSavedTaskProgress(current, tabSize, hadTasks));
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
    };
    native.load();
    native.set(this.ta.value);
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

  updateTaskProgress({ closed, total }) {
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
        const all = [...document.querySelectorAll(".pm-modal--task")].filter((m) => m.isConnected);
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

    const insertText = (text, range) => {
        const target = curTarget;
        if (!target) return false;
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
        new DatePopover(app, detected, replaceRange || null, anchorEl).open();
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
        constructor(app, detected, replaceAt, anchorEl) {
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
            const st = {
                start: snapDate(now, this.step),
                end: null,
                withTime: loadPrefs().withTime !== false,
                target: "start",
                deadlineOnly: false,
                vy: now.getFullYear(),
                vm: now.getMonth(),
            };
            if (this.detected) {
                const s = this.parse(this.detected.startValue);
                const e = this.parse(this.detected.endValue);
                if (s) st.start = s;
                if (e) st.end = e;
                st.withTime = !!this.detected.hasTime;
                st.deadlineOnly = !!this.detected.deadlineOnly;
                if (st.deadlineOnly) st.start = new Date(e.getTime());
                if (e && (st.deadlineOnly || this.detected.target === "end")) st.target = "end";
                const activeDate = st.target === "end" ? st.end : st.start;
                st.vy = activeDate.getFullYear();
                st.vm = activeDate.getMonth();
            }

            const el = document.createElement("div");
            el.className = "dotpm-dm-pop";
            el.dataset.role = "popover";
            this.el = el;
            const bodyEl = document.createElement("div");
            bodyEl.className = "dotpm-dm-body";
            const cal = document.createElement("div");
            cal.className = "dotpm-dm-cal";
            const side = document.createElement("div");
            side.className = "dotpm-dm-side";
            const gTime = document.createElement("div");
            gTime.className = "dotpm-dm-group";
            const gDates = document.createElement("div");
            gDates.className = "dotpm-dm-group";
            const gSteps = document.createElement("div");
            gSteps.className = "dotpm-dm-group";
            bodyEl.append(cal, side);
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
            gTime.appendChild(tgtRow);

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

            // 时间行
            const timeRow = document.createElement("div");
            timeRow.className = "dotpm-dm-timerow";
            const timeInp = document.createElement("input");
            timeInp.type = "text";
            timeInp.maxLength = 5;
            timeInp.placeholder = "HH:MM";
            timeInp.autocomplete = "off";
            timeInp.setAttribute("aria-label", "时刻（24 小时制）");
            timeInp.dataset.role = "time";
            const timeChk = document.createElement("input");
            timeChk.type = "checkbox";
            timeChk.checked = st.withTime;
            timeChk.dataset.role = "timemode";
            const timeLb = document.createElement("label");
            timeLb.className = "dotpm-dm-check";
            timeLb.append(timeChk, document.createTextNode("带时间"));
            const stepSel = document.createElement("select");
            stepSel.dataset.role = "step";
            stepSel.title = "取整步长：取整按钮与 ±步长 都按它计算";
            [["15", "15分"], ["30", "30分"], ["60", "整点"]].forEach(([v, t]) => {
                const o = document.createElement("option");
                o.value = v; o.textContent = t;
                stepSel.appendChild(o);
            });
            stepSel.value = String(this.step);

            const mkChip = (parent, label, role, tip, mono, cls) => {
                const b = document.createElement("button");
                b.className = "dotpm-dm-chip" + (mono ? " dotpm-dm-chip--mono" : "") + (cls ? " " + cls : "");
                b.textContent = label;
                b.dataset.role = role;
                if (tip) b.title = tip;
                parent.appendChild(b);
                return b;
            };

            // ── 模块 1：时间控制（带时间 / 时刻 / 现在 / 步长）
            timeRow.append(timeLb, timeInp, stepSel);
            gTime.appendChild(timeRow);

            // ── 模块 1b：时间步进（仅带时间时可用）
            const timeSteps = document.createElement("div");
            timeSteps.className = "dotpm-dm-chips dotpm-dm-timesteps";
            const nowBtn = mkChip(timeSteps, "现在", "now", "把当前目标设为此刻");
            const snapBtn = mkChip(timeSteps, "取整", "snap", "按步长把目标时间对齐（13:16 → 13:30）");
            const minusBtn = mkChip(timeSteps, "", "minusstep", "给当前目标减一个步长，可连点累减");
            const durBtn = mkChip(timeSteps, "", "duration", "给当前目标加一个步长，可连点累加");
            gTime.appendChild(timeSteps);

            // ── 模块 2：日期锚点（跳到具体某天）
            const chips = document.createElement("div");
            chips.className = "dotpm-dm-chips";
            chips.classList.add("dotpm-dm-chips--4");
            [
                ["上周", "lastweek", "跳到上周同一天"],
                ["昨天", "yesterday", "跳到昨天（保留时分）"],
                ["明天", "tomorrow", "跳到明天"],
                ["下周", "nextweek", "跳到下周同一天"],
                ["−1周", "minusweek", "在已选日期上减 1 周"],
                ["−1天", "minus1", "在已选日期上减 1 天"],
                ["+1天", "plus1", "在已选日期上加 1 天"],
                ["+1周", "plusweek", "在已选日期上加 1 周"],
            ].forEach(([label, role, tip]) => mkChip(chips, label, role, tip));
            gDates.appendChild(chips);
            side.append(gTime, gDates);

            const bottom = document.createElement("div");
            bottom.className = "dotpm-dm-bottom";
            const prevBox = document.createElement("div");
            prevBox.className = "dotpm-dm-preview";
            prevBox.dataset.role = "preview";
            bottom.appendChild(prevBox);
            el.appendChild(bottom);

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
            bottom.appendChild(foot);

            const targetDate = () => (st.target === "end" ? st.end : st.start);
            const setTargetDate = (d) => {
                if (st.target === "end") st.end = d; else st.start = d;
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
            const previewToken = () => st.deadlineOnly ? "截止 " + token().slice(1) : token();

            const render = () => {
                // 正在拖拽时用拖拽区间，否则用已选区间
                let rangeA = st.deadlineOnly ? null : dayKey(st.start);
                let rangeB = st.end ? dayKey(st.end) : null;
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
                clearStart.hidden = !!this.detected?.valueOnly || st.deadlineOnly;
                clearEnd.hidden = !st.end;
                bStart.title = "点日期改开始日期";
                bEnd.title = st.end ? "点日期改结束日期" : "选一个结束日期（做时间段）";
                const sel = targetDate();
                const today = new Date();
                const first = new Date(st.vy, st.vm, 1);
                const startIdx = first.getDay();
                const base = new Date(st.vy, st.vm, 1 - startIdx);
                grid.textContent = "";
                const daysInMonth = new Date(st.vy, st.vm + 1, 0).getDate();
                const rows = Math.ceil((startIdx + daysInMonth) / 7);
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
                        if (sel && key === dayKey(sel)) b.classList.add("is-selected");
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
                refreshDur();
                const t = targetDate();
                timeInp.value = t ? hm(t) : "09:00";
                timeInp.removeAttribute("aria-invalid");
                const noTime = !st.withTime;
                timeInp.disabled = noTime;
                nowBtn.disabled = noTime;
                minusBtn.disabled = noTime;
                durBtn.disabled = noTime;
                timeSteps.style.opacity = noTime ? "0.45" : "";
                stepSel.disabled = !st.withTime;
                prevBox.textContent = previewToken();
                try {
                    prevBox.classList.remove("is-flash");
                    void prevBox.offsetWidth;
                    prevBox.classList.add("is-flash");
                } catch (e) {}
            };

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

            timeChk.onchange = () => { st.withTime = timeChk.checked; savePrefs({ withTime: st.withTime }); render(); };
            const applyTimeInput = () => {
                if (!st.withTime) return true;
                const m = /^(\d{1,2}):(\d{2})$/.exec(timeInp.value.trim());
                if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
                    timeInp.setAttribute("aria-invalid", "true");
                    return false;
                }
                timeInp.removeAttribute("aria-invalid");
                const t = targetDate() || st.start;
                setTargetDate(new Date(t.getFullYear(), t.getMonth(), t.getDate(), +m[1], +m[2], 0, 0));
                prevBox.textContent = previewToken();
                return true;
            };
            timeInp.addEventListener("input", applyTimeInput);
            stepSel.onchange = () => { this.step = Number(stepSel.value) || 30; savePrefs({ step: this.step }); render(); };

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
            // 相对「今天」：把目标字段设成 今天±N，保留当前时:分
            const setFromToday = (days, months) => {
                const t = targetDate() || st.start;
                const base = new Date();
                if (days) base.setDate(base.getDate() + days);
                if (months) base.setMonth(base.getMonth() + months);
                base.setHours(st.withTime && t ? t.getHours() : 9, st.withTime && t ? t.getMinutes() : 0, 0, 0);
                setTargetDate(base);
                st.vy = base.getFullYear();
                st.vm = base.getMonth();
                render();
            };
            chips.querySelector('[data-role=tomorrow]')?.addEventListener("click", () => setFromToday(1));
            chips.querySelector('[data-role=yesterday]')?.addEventListener("click", () => setFromToday(-1));
            chips.querySelector('[data-role=lastweek]')?.addEventListener("click", () => setFromToday(-7));
            chips.querySelector('[data-role=nextweek]')?.addEventListener("click", () => setFromToday(7));
            nowBtn.onclick = () => {
                const now = new Date();
                const t = targetDate() || st.start;
                const nd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes(), 0, 0);
                setTargetDate(nd);
                st.vy = nd.getFullYear();
                st.vm = nd.getMonth();
                render();
            };
            // 相对「已选」：在当前值上平移
            chips.querySelector('[data-role=minusweek]')?.addEventListener("click", () => shift(-7, 0));
            chips.querySelector('[data-role=plusweek]')?.addEventListener("click", () => shift(7, 0));
            chips.querySelector('[data-role=minus1]')?.addEventListener("click", () => shift(-1, 0));
            chips.querySelector('[data-role=plus1]')?.addEventListener("click", () => shift(1, 0));
            const stepNow = () => (st.withTime ? this.step : 0);
            const durText = () => {
                const v = stepNow();
                if (!v) return "+1天";
                return v % 60 === 0 ? `+${v / 60}时` : `+${v}分`;
            };
            const refreshDur = () => {
                durBtn.textContent = durText();
                minusBtn.textContent = "−" + durText().replace("+", "").trim();
                const who = st.deadlineOnly ? "截止" : st.target === "end" ? "结束" : "开始";
                durBtn.title = `给「${who}」加 ${durText().replace("+", "").trim()}，可连续点击累加`;
                minusBtn.title = `给「${who}」减 ${durText().replace("+", "").trim()}，可连续点击累减`;
            };
            snapBtn.onclick = () => {
                const step = stepNow();
                const t = targetDate() || st.start;
                if (!t) return;
                if (!step) { new Notice("先把取整设为 15/30/整点"); return; }
                const nd = snapDate(t, step);
                setTargetDate(nd);
                st.vy = nd.getFullYear();
                st.vm = nd.getMonth();
                render();
            };
            minusBtn.onclick = () => {
                const t = targetDate() || st.start || new Date();
                const inc = st.withTime ? stepNow() * 60000 : 86400000;
                const nd = new Date(t.getTime() - inc);
                setTargetDate(nd);
                st.vy = nd.getFullYear();
                st.vm = nd.getMonth();
                render();
            };
            durBtn.onclick = () => {
                const t = targetDate() || st.start || new Date();
                const inc = st.withTime ? stepNow() * 60000 : 86400000;
                const nd = new Date(t.getTime() + inc);
                setTargetDate(nd);
                st.vy = nd.getFullYear();
                st.vm = nd.getMonth();
                render();
            };

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
                if (!applyTimeInput()) {
                    new Notice("请输入有效的时刻，例如 15:26。");
                    timeInp.focus();
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
                if (t?.closest?.("select, input[data-role=time]")) return;
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

        place() {
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
            const bw = el.offsetWidth, bh = el.offsetHeight;

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
