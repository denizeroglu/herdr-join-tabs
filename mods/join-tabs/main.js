// Join two tabs side by side, like VS Code's split editor: this tab's panes
// move into another tab of the same space, to the right of what's there, and
// the emptied tab closes. The reverse, props.action "separate", moves one pane
// out to a tab of its own. Programs keep running throughout.
// Herdr has no command for either. Like move-to-space, this parks each
// terminal (its pane goes, the program keeps running), then keeps it again
// where it belongs: terminal.keep with place "right" / "down", or a new tab.
// Keys: ↑/↓ or 1–9 to pick, Enter to join, Esc to cancel.
// props: tab (default: the shown one), to (a tab id: join at once),
//        action: "separate" with terminal (default: the focused one),
//        action: "join-pane" with terminal and to: that one pane joins tab `to`.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, run, theme, props, closeOverlay, notify, checking } from "herdr";

// park and keep are confirmed by herdr-core after a moment: keep sent before
// park lands can be lost, so wait, and check that each pane really arrived.
const PARK_SETTLE = 400, POLL = 100, RETRY_AT = 10, GIVE_UP = 30;

// A tab's name as the tab bar shows it: a name the person gave stays; an
// unnamed tab follows its agent's live title, else its program.
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").replace(/^\[ [!.] \] /, "").trim();
function tabLabel(tab) {
  const lead = panes().find((p) => p.tab === tab.id && p.program?.agent) ?? panes().find((p) => p.tab === tab.id);
  const prog = lead?.program?.name;
  const base = tab.named ? tab.name : prog ?? "Terminal";
  if (!lead?.program?.agent) return base;
  const live = clean(lead.title);
  const path = /^[~/]|^[A-Za-z]:\\/.test((lead.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  const telling = live && live !== lead.terminal && live !== prog && !path && !live.includes("@") && live.toLowerCase() !== lead.program.key;
  return (tab.name === prog || !tab.named) && telling ? live : base;
}

export default class JoinTabs extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.at = 0;
    this.busy = false;
    const p = props() ?? {};
    const f = focused();
    this.tab = p.tab ?? f?.tab ?? null;
    if (checking()) return;
    if (p.action === "separate") this.separate(p.terminal ?? f?.terminal ?? null, cx);
    else if (p.action === "join-pane") {
      this.tab = panes().find((x) => x.terminal === p.terminal)?.tab ?? null;
      this.join(p.to, cx, [p.terminal]);
    } else if (p.to) this.join(p.to, cx);
  }

  allTabs() {
    return spaces().flatMap((s) => s.tabs);
  }

  // Other tabs of this tab's space, in their order.
  targets() {
    const space = spaces().find((s) => s.tabs.some((t) => t.id === this.tab));
    return (space?.tabs ?? []).filter((t) => t.id !== this.tab);
  }

  done() {
    closeOverlay(props()?.overlay);
  }

  fail(terminals) {
    notify({ title: "Couldn't finish", body: `${terminals.join(", ")} still running without a pane: they show in the agents list, or run terminal.keep.`, level: "error" });
    this.done();
  }

  // Keep one parked terminal, then wait until its pane shows up where `arrived` says.
  keep(terminal, place, arrived, cx, next) {
    run("terminal.keep", place ? { terminal, place } : { terminal });
    let tries = 0;
    const settle = (cx) => {
      const pane = panes().find((p) => p.terminal === terminal);
      if (pane && arrived(pane)) return next(pane, cx);
      tries++;
      if (tries === RETRY_AT) run("terminal.keep", place ? { terminal, place } : { terminal });
      if (tries < GIVE_UP) return cx.timer.after(POLL, settle);
      next(null, cx);
    };
    cx.timer.after(POLL, settle);
  }

  join(to, cx, only = null) {
    if (this.busy || to === this.tab) return this.done();
    const moving = only ?? panes().filter((p) => p.tab === this.tab && p.terminal).map((p) => p.terminal);
    if (!moving.length || !this.allTabs().some((t) => t.id === to)) return this.done();
    this.busy = true;
    for (const terminal of moving) run("terminal.park", { terminal });
    cx.timer.after(PARK_SETTLE, (cx) => {
      run("tab.select", { id: to });
      // Start from the target's last pane, so the joined panes land on its right.
      const last = panes().filter((p) => p.tab === to).at(-1);
      if (last) run("pane.focus", { pane: last.pane });
      // The first joined pane goes right; any others stack below it.
      const step = (i, cx) => {
        if (i === moving.length) return this.done();
        this.keep(moving[i], i === 0 ? "right" : "down", (pane) => pane.tab === to, cx, (pane, cx) => {
          if (!pane) return this.fail(moving.slice(i));
          run("pane.focus", { pane: pane.pane });
          step(i + 1, cx);
        });
      };
      step(0, cx);
    });
    cx.notify();
  }

  separate(terminal, cx) {
    const from = panes().find((p) => p.terminal === terminal);
    if (!from || this.busy) return this.done();
    // A pane alone in its tab is already separate.
    if (panes().filter((p) => p.tab === from.tab).length < 2) return this.done();
    this.busy = true;
    run("terminal.park", { terminal });
    cx.timer.after(PARK_SETTLE, (cx) => {
      this.keep(terminal, null, (pane) => pane.tab !== from.tab, cx, (pane) => {
        if (!pane) return this.fail([terminal]);
        // keep names the new tab after the terminal; unnamed, it follows its agent.
        run("tab.rename", { id: pane.tab, name: "" });
        this.done();
      });
    });
    cx.notify();
  }

  render() {
    const t = theme();
    const here = this.allTabs().find((x) => x.id === this.tab);
    const list = this.targets();
    this.at = Math.min(this.at, Math.max(0, list.length - 1));
    const title = this.busy ? (props()?.action === "separate" ? "Moving…" : "Joining…") : !here ? "No tab to join" : list.length ? `Join “${tabLabel(here)}” beside…` : "No other tab in this space";
    return v_flex()
      .id("join-tabs")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (this.busy) return;
        if (k === "escape") this.done();
        else if (k === "down" && list.length) this.at = (this.at + 1) % list.length;
        else if (k === "up" && list.length) this.at = (this.at - 1 + list.length) % list.length;
        else if (k === "enter" && list[this.at]) this.join(list[this.at].id, cx);
        else if (/^[1-9]$/.test(k) && list[+k - 1]) this.join(list[+k - 1].id, cx);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .w_full()
      .p(8)
      .gap(4)
      .rounded(12)
      .bg(t.popover)
      .text_size(13)
      .child(h_flex().px(8).pt(4).pb(8).items_center().justify_between()
        .child(div().min_w(0).truncate().font_semibold().text_color(t.foreground).child(title))
        .child(div().text_size(11).text_color(t.dim).child(this.busy ? "" : "Esc")))
      .when(Boolean(here) && !this.busy, (el) => el.children(list.map((x, i) => h_flex()
        .id(`join-${x.id}`)
        .h(32)
        .px(8)
        .gap(12)
        .items_center()
        .rounded(8)
        .cursor_pointer()
        .when(i === this.at, (r) => r.bg(t.selected))
        .hover((r) => r.bg(t.hover))
        .on_click((_e, cx) => this.join(x.id, cx))
        .child(div().w(12).text_size(11).text_color(t.dim).child(i < 9 ? String(i + 1) : ""))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(tabLabel(x)))
        .when(x.panes > 1, (r) => r.child(div().text_size(11).text_color(t.dim).child(`${x.panes} panes`))))));
  }
}
