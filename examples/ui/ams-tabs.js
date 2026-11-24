/**
 * A tab strip over its children: each child is a pane, named by its `data-tab`. The first opens
 * first; arrow keys, Home and End move between tabs.
 */
class AmsTabs extends HTMLElement {
  connectedCallback() {
    if (this.querySelector(".tabs")) return;
    const strip = document.createElement("div");
    strip.className = "tabs";
    strip.setAttribute("role", "tablist");
    for (const pane of this.children) {
      const name = pane.dataset.tab;
      pane.id ||= `pane-${name.toLowerCase()}`;
      pane.setAttribute("role", "tabpanel");
      pane.setAttribute("aria-label", name);
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "tab";
      tab.textContent = name;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-controls", pane.id);
      tab.onclick = () => this.open(name);
      strip.append(tab);
    }
    strip.onkeydown = (e) => {
      const tabs = [...strip.children];
      const i = tabs.indexOf(document.activeElement);
      const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
      if (i < 0 || next === undefined) return;
      e.preventDefault();
      this.open(tabs.at(next % tabs.length).textContent, true);
    };
    this.prepend(strip);
    this.open(strip.firstElementChild.textContent);
  }

  /** Show the pane named `name`; `focus` moves the keyboard focus to its tab. */
  open(name, focus = false) {
    for (const tab of this.querySelectorAll(".tab")) {
      const on = tab.textContent === name;
      tab.setAttribute("aria-selected", on);
      tab.tabIndex = on ? 0 : -1;
      document.getElementById(tab.getAttribute("aria-controls")).hidden = !on;
      if (on && focus) tab.focus();
    }
  }
}

customElements.define("ams-tabs", AmsTabs);
