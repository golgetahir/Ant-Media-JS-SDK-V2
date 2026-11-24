/**
 * Menu behaviour of a dock button: `host` holds the button, then its `.menu`. The arrow keys move
 * between the items, Escape and the focus leaving close it, picking an item closes it and calls
 * `pick(item)`. Returns `show(open)`, which opens on the checked item, else the first.
 */
export function dockMenu(host, pick) {
  const [button, menu] = host.children;
  const show = (open) => {
    menu.hidden = !open;
    button.setAttribute("aria-expanded", open);
    if (open) (menu.querySelector('[aria-checked="true"]') ?? menu.firstElementChild)?.focus();
  };
  menu.onclick = (e) => {
    const item = e.target.closest('[role^="menuitem"]');
    if (!item) return;
    show(false);
    button.focus();
    pick(item);
  };
  host.onkeydown = (e) => {
    const items = [...menu.children];
    const i = items.indexOf(document.activeElement);
    if (e.key === "Escape" && !menu.hidden) {
      show(false);
      button.focus();
    } else if (i >= 0 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      items.at((i + (e.key === "ArrowDown" ? 1 : -1)) % items.length).focus();
    }
  };
  // closes when the focus leaves it: Tab, a click elsewhere
  host.addEventListener("focusout", (e) => host.contains(e.relatedTarget) || show(false));
  return show;
}
