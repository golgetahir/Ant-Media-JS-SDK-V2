// Classic script loaded in <head> so the remembered theme is set before the first paint.
// Any [data-theme-toggle] button (the top bar's) switches the theme and remembers it.
(() => {
  const key = "ams-theme";
  const root = document.documentElement;
  try {
    root.dataset.theme = localStorage.getItem(key) === "light" ? "light" : "dark";
  } catch {
    root.dataset.theme = "dark";
  }
  addEventListener("click", (e) => {
    if (!e.target.closest("[data-theme-toggle]")) return;
    root.dataset.theme = root.dataset.theme === "light" ? "dark" : "light";
    try {
      localStorage.setItem(key, root.dataset.theme);
    } catch {
      // not remembered, still switched
    }
  });
})();
