// Agent quota in the status bar: one slim bar per limit window, from `quota-axi --json`.
// Click it for details and options. The same mod draws the popup (props().menu).
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, theme, settings, shared, setShared, props, openOverlay, knownAgents, nextCommand } from "herdr";

const EVERY = 120000, STALE = 10 * 60000;
const DEFAULTS = { kinds: { session: true, weekly: true, monthly: true, model: false }, hidden: [], signedOut: false, names: false };
const ICONS = { claude: "claude", codex: "codex", grok: "grok", kimi: "kimi", copilot: "copilot", cursor: "cursor" };
const TINT = { claude: "#d97757", kimi: "#1783ff", copilot: "#8f6bf2" };
const KINDS = [["session", "5-hour limit"], ["weekly", "Weekly limit"], ["monthly", "Monthly limit"], ["model", "Model limits"]];

// Layout props set the starting options (`{"mod": "quota", "props": {"hidden": ["cursor"]}}`); the popup's choices win.
function options() {
  const start = props()?.menu ? props().start ?? {} : props() ?? {}, saved = shared("quota.options") ?? {};
  return { ...DEFAULTS, ...start, ...saved, kinds: { ...DEFAULTS.kinds, ...(start.kinds ?? {}), ...(saved.kinds ?? {}) } };
}
const setOptions = change => setShared("quota.options", { ...options(), ...change });
const signedIn = p => p.windows.length > 0;

// Calm until it matters: green, amber from 60%, orange from 80%, red from 92%.
function level(pct) {
  const dark = settings().dark !== false;
  const scale = dark ? ["#5ed49a", "#f2c14e", "#f59152", "#f2665c"] : ["#1f9d63", "#c98a0b", "#dd6b20", "#d64545"];
  return scale[pct >= 92 ? 3 : pct >= 80 ? 2 : pct >= 60 ? 1 : 0];
}

// Two windows of one kind (Cursor's monthly ones) are told apart by their own label.
function short(w, twin) {
  if (twin) return (w.label ?? w.kind).split(" ")[0].slice(0, 6);
  if (w.kind === "session") return w.windowSeconds ? `${Math.round(w.windowSeconds / 3600)}h` : "5h";
  if (w.kind === "weekly") return "wk";
  if (w.kind === "monthly") return "mo";
  return (w.label ?? "model").split(" ")[0].slice(0, 6);
}

// Share of the window already gone, 0..1; null without a reset time.
function elapsed(w, now) {
  if (!w.resetsAt || !w.windowSeconds) return null;
  const left = (Date.parse(w.resetsAt) - now) / 1000;
  return Math.min(1, Math.max(0, 1 - left / w.windowSeconds));
}

function until(iso, now) {
  const min = Math.max(0, Math.round((Date.parse(iso) - now) / 60000));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h}h ${min % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

function ago(at, now) {
  const min = Math.round((now - at) / 60000);
  return min < 1 ? "just now" : `${min}m ago`;
}

function pace(w, now) {
  const e = elapsed(w, now);
  if (e === null || e < 0.03) return null;
  const diff = Math.round(w.percentUsed - e * 100);
  return { diff, ahead: diff >= 10 && w.percentUsed >= 20 };
}

function bar(w, width, height, now, t) {
  const e = elapsed(w, now), pct = Math.min(100, Math.max(0, w.percentUsed));
  return div().relative().w(width).h(height).flex_none().rounded(height / 2).bg(t.border)
    .child(div().absolute().left(0).top(0).h(height).w(Math.max(pct > 0 ? height : 0, width * pct / 100)).rounded(height / 2).bg(level(pct)))
    .when(e !== null, el => el.child(div().absolute().top(-2).h(height + 4).w(1).left(Math.round(width * e)).bg(t.foreground).opacity(0.45)));
}

async function load() {
  let r = await exec("quota-axi", ["--json"]).catch(e => ({ code: -1, stderr: String(e) }));
  // Apps started from the Dock miss PATH entries set in the shell's rc file (npm, nvm, mise): ask the person's own shell.
  // Login only — an interactive shell (-i) without a tty can hang the app window.
  if (r.code !== 0) r = await exec("sh", ["-c", 'exec "${SHELL:-/bin/sh}" -lc "quota-axi --json" </dev/null']).catch(e => ({ code: -1, stderr: String(e) }));
  if (r.code !== 0) throw new Error(`quota-axi failed: ${(r.stderr || "").trim().split("\n").pop() || `exit ${r.code}`}`);
  // A login shell can print a banner first; the report starts at the first brace.
  const start = r.stdout.indexOf("{");
  if (start < 0) throw new Error(`quota-axi failed: ${(r.stderr || r.stdout || "").trim().split("\n").pop() || `exit ${r.code}`}`);
  const data = JSON.parse(r.stdout.slice(start));
  return {
    at: Date.now(),
    providers: (data.providers ?? []).map(p => ({
      id: p.provider, label: p.label ?? p.provider, plan: p.plan ?? null, status: p.state?.status ?? null,
      // quota-axi 0.1.69 reports windows as percentRemaining (percentUsed only survives
      // inside shareOf blocks); derive percentUsed so the bar keeps one field downstream.
      windows: (p.windows ?? [])
        .map(w => ({ ...w, percentUsed: w.percentUsed ?? (w.percentRemaining != null ? 100 - w.percentRemaining : null) }))
        .filter(w => typeof w.percentUsed === "number")
        .map(w => ({ id: w.id, label: w.label, kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt ?? null, windowSeconds: w.windowSeconds ?? null })),
    })),
  };
}

export default class Quota extends View {
  init(_props, cx) {
    // The app's program table knows each agent's icon and whether it is a one-color glyph.
    this.programs = {};
    cx.spawn(async cx => {
      const list = await knownAgents().catch(() => []);
      for (const a of list) this.programs[a.key] = a;
      cx.notify();
    });
    if (props()?.menu) return;
    this.asked = shared("quota.refresh") ?? 0;
    this.refresh(cx);
    cx.timer.every(EVERY, cx => this.refresh(cx));
    // Key commands: "quota:menu" opens the popup, "quota:refresh" reads the quota now.
    cx.spawn(async cx => {
      for (;;) {
        const c = await nextCommand();
        if (c === "menu") this.openMenu();
        if (c === "refresh") this.refresh(cx);
      }
    });
  }

  glyph(p, size, t) {
    const program = this.programs[p.id], icon = program?.icon ?? (ICONS[p.id] ? `icons/${ICONS[p.id]}.svg` : null);
    if (!icon) return div().size(6).rounded(3).flex_none().bg(t.dim);
    const el = TINT[p.id] || !program || program.tint
      ? svg(icon).size(size).flex_none().text_color(TINT[p.id] ?? program?.color ?? t.foreground)
      : image(icon).size(size).flex_none().rounded(3);
    return signedIn(p) ? el : el.opacity(0.35);
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.spawn(async cx => {
      try { setShared("quota.data", await load()); setShared("quota.error", null); }
      catch (e) { setShared("quota.error", String(e.message ?? e)); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  openMenu() {
    const data = shared("quota.data"), o = options();
    const all = data?.providers ?? [], shown = all.filter(p => !o.hidden.includes(p.id) && (signedIn(p) || o.signedOut));
    const details = shown.reduce((n, p) => n + 30 + p.windows.length * 42, 0);
    const toggles = (KINDS.length + all.length + 2) * 28;
    openOverlay({ mod: "quota", kind: "popup", width: 300, height: Math.min(720, 44 + details + 40 + toggles + 12), props: { menu: true, start: props() ?? {} } });
  }

  render(cx) {
    const t = theme();
    if (props()?.menu) return this.menu(t);
    const ask = shared("quota.refresh") ?? 0;
    if (ask !== this.asked) { this.asked = ask; this.refresh(cx); }
    const data = shared("quota.data"), error = shared("quota.error"), o = options(), now = Date.now();
    const stale = !data || now - data.at > STALE;
    const list = (data?.providers ?? []).filter(p => !o.hidden.includes(p.id) && (signedIn(p) || o.signedOut));
    const parts = [];
    list.forEach((p, i) => {
      if (i > 0) parts.push(div().w(1).h(12).flex_none().bg(t.border));
      const windows = p.windows.filter(w => o.kinds[w.kind] ?? false);
      parts.push(h_flex().id(`q-${p.id}`).gap(9).items_center().flex_none()
        .tooltip(windows.map(w => `${p.label} ${w.label}: ${w.percentUsed}% used${w.resetsAt && Date.parse(w.resetsAt) > now ? `, resets in ${until(w.resetsAt, now)}` : ""}`).join("\n") || `${p.label}: not signed in`)
        .child(h_flex().gap(5).items_center()
          .child(this.glyph(p, 12, t))
          .when(o.names || !ICONS[p.id], el => el.child(div().text_color(signedIn(p) ? t.muted : t.dim).child(p.label))))
        .when(!signedIn(p), el => el.child(div().size(6).rounded(3).border_1().border_color(t.dim)))
        .children(windows.map(w => {
          const pc = pace(w, now);
          return h_flex().gap(5).items_center()
            .child(div().text_size(10).text_color(t.dim).child(short(w, windows.filter(x => x.kind === w.kind).length > 1)))
            .child(bar(w, 34, 4, now, t))
            .child(div().min_w(24).text_size(11).text_color(w.percentUsed >= 60 ? level(w.percentUsed) : t.muted).child(`${Math.round(w.percentUsed)}%`))
            .when(Boolean(pc?.ahead), el => el.child(div().ml(-3).text_size(8).text_color(level(Math.max(60, w.percentUsed))).child("▲")));
        })));
    });
    return h_flex().id("quota").size_full().px(12).gap(11).items_center().justify_end().overflow_hidden()
      .bg(t.chrome).border_t(1).border_color(t.border).text_size(11.5).text_color(t.muted).cursor_pointer()
      .when(stale, el => el.opacity(0.6))
      .on_click(() => this.openMenu())
      .on_mouse_down("right", () => this.openMenu())
      .when(parts.length === 0, el => el.child(div().text_color(t.dim).child(error ? "Quota unavailable" : data ? "No quota to show" : "Quota…")))
      .children(parts);
  }

  menu(t) {
    const data = shared("quota.data"), error = shared("quota.error"), o = options(), now = Date.now();
    const all = data?.providers ?? [];
    const toggle = (label, on, act, id) => h_flex().id(id).h(28).px(8).gap(9).rounded(6).items_center().cursor_pointer()
      .hover(s => s.bg(t.hover)).on_click(act)
      .child(div().size(14).flex_none().rounded(4).border_1().border_color(on ? level(0) : t.input).bg(on ? level(0) : t.popover)
        .when(on, el => el.child(div().size_full().flex().items_center().justify_center().text_size(10).text_color(t.popover).child("✓"))))
      .child(div().flex_1().text_color(t.foreground).child(label));
    const heading = text => div().px(8).pt(10).pb(4).text_size(10.5).text_color(t.dim).child(text);
    const details = all.filter(p => !o.hidden.includes(p.id) && (signedIn(p) || o.signedOut)).map(p => v_flex().px(8).py(4).gap(4)
      .child(h_flex().gap(6).items_center()
        .child(this.glyph(p, 13, t))
        .child(div().font_semibold().text_color(t.foreground).child(p.label))
        .child(div().text_size(10.5).text_color(t.dim).child(signedIn(p) ? (p.plan ?? "") : "not signed in")))
      .children(p.windows.map(w => {
        const pc = pace(w, now);
        return v_flex().gap(3)
          .child(h_flex().gap(8).items_center()
            .child(div().w(62).flex_none().truncate().text_size(11.5).text_color(t.muted).child(w.kind === "session" ? "5 hours" : w.kind === "weekly" ? "Week" : w.label))
            .child(bar(w, 120, 5, now, t))
            .child(div().flex_1().text_right().text_size(11.5).text_color(w.percentUsed >= 60 ? level(w.percentUsed) : t.foreground).child(`${Math.round(w.percentUsed)}%`)))
          .child(div().pl(70).text_size(10.5).text_color(t.dim).child([
            w.resetsAt && Date.parse(w.resetsAt) > now ? `resets in ${until(w.resetsAt, now)}` : null,
            pc ? (Math.abs(pc.diff) < 5 ? "on pace" : pc.diff > 0 ? `${pc.diff}% ahead of pace` : `${-pc.diff}% under pace`) : null,
          ].filter(Boolean).join(" · ")));
      })));
    return v_flex().id("quota-menu").w_full().p(5).bg(t.popover).text_size(12.5).overflow_y_scrollbar()
      .child(h_flex().px(8).pt(4).pb(2).items_center()
        .child(div().flex_1().text_size(11).text_color(t.dim).child(data ? `Agent quota · updated ${ago(data.at, now)}` : "Agent quota"))
        .child(div().id("quota-refresh").px(6).rounded(5).cursor_pointer().text_size(11).text_color(t.muted).hover(s => s.bg(t.hover))
          .on_click(() => setShared("quota.refresh", Date.now())).child("Refresh")))
      .when(Boolean(error), el => el.child(div().px(8).py(4).text_size(11).text_color(level(95)).child(error)))
      .children(details)
      .child(div().mx(8).my(6).h(1).bg(t.border))
      .child(heading("Show in the status bar"))
      .children(KINDS.map(([kind, label]) => toggle(label, o.kinds[kind], () => setOptions({ kinds: { ...o.kinds, [kind]: !o.kinds[kind] } }), `kind-${kind}`)))
      .children(all.map(p => toggle(p.label, !o.hidden.includes(p.id),
        () => setOptions({ hidden: o.hidden.includes(p.id) ? o.hidden.filter(x => x !== p.id) : [...o.hidden, p.id] }), `prov-${p.id}`)))
      .child(toggle("Signed-out providers", o.signedOut, () => setOptions({ signedOut: !o.signedOut }), "signed-out"))
      .child(toggle("Provider names", o.names, () => setOptions({ names: !o.names }), "names"));
  }
}
